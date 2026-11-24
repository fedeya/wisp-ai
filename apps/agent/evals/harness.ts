// Runs one eval with Mastra's runEvals: the real turn agent from the engine,
// fixture stubs for game and integration tools, gates that must pass and
// scorers that are tracked against a threshold of 1.
import { isDeepStrictEqual } from 'node:util';
import { runEvals } from '@mastra/core/evals';
import type { MastraScorer } from '@mastra/core/evals';
import { createAgentEngine, type ToolStubOutcome } from '../src/engine.ts';
import { agentHost } from '../src/agent-host.ts';
import { resultView, type TurnView } from './checks.ts';
import { playerMessage } from './fixtures/fedrath.ts';

/** Answers a tool from a fixture; the first stub whose tool and `match` fit wins. */
export interface ToolStub {
  id: string;
  tool: string;
  /** Input fields that must equal `const`. */
  match?: Record<string, { const: unknown }>;
  outcome: ToolStubOutcome;
}

type Scorer = MastraScorer<any, any, any, any>;

export interface EvalDefinition {
  description: string;
  tags?: string[];
  /** What the player asks; it is sent with the fixture character's game context. */
  question: string;
  stubs: ToolStub[];
  /** Hard requirements: the eval fails when one scores below 1. */
  gates: Scorer[];
  /** Soft requirements: reported when one scores below 1. */
  scorers?: Scorer[];
}
export const defineEval = (definition: EvalDefinition) => definition;

function matches(stub: ToolStub, tool: string, input: unknown) {
  if (stub.tool !== tool) {
    return false;
  }
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return Object.entries(stub.match ?? {}).every(([key, rule]) =>
    isDeepStrictEqual(fields[key], rule.const),
  );
}

export interface EvalOutcome {
  verdict: 'passed' | 'scored' | 'failed';
  failed: string[];
  soft: string[];
  turn?: TurnView;
  steps: number;
  error?: string;
}

export async function runEval(definition: EvalDefinition): Promise<EvalOutcome> {
  const host = agentHost();
  if (!host) {
    throw Error('Start the eval bridge before running evals.');
  }
  const engine = createAgentEngine({
    origin: () => host.origin,
    token: host.token,
    // Each eval is a single new turn; nothing is resumed.
    history: {
      load: async () => [],
      append: async () => {},
      replace: async () => {},
      delete: async () => {},
    },
    logger: { info: () => {}, warn: () => {} },
    stub: (tool, input) => definition.stubs.find((stub) => matches(stub, tool, input))?.outcome,
  });
  try {
    const { agent, options } = await engine.agent(
      engine.newSessionId(),
      AbortSignal.timeout(300_000),
    );
    let turn: TurnView | undefined;
    let steps = 0;
    let error: string | undefined;
    const result = await runEvals({
      target: agent,
      data: [{ input: playerMessage(definition.question) }],
      gates: definition.gates,
      scorers: (definition.scorers ?? []).map((scorer) => ({ scorer, threshold: 1 })),
      targetOptions: options as never,
      onItemComplete: ({ targetResult }) => {
        const output = targetResult as Parameters<typeof resultView>[0] & {
          steps?: unknown[];
          error?: { message?: string };
        };
        turn = resultView(output);
        steps = output.steps?.length ?? 0;
        error = output.error?.message;
      },
    });
    const name = (id: string) =>
      [...definition.gates, ...(definition.scorers ?? [])].find((scorer) => scorer.id === id)
        ?.name ?? id;
    return {
      verdict: result.verdict ?? 'passed',
      failed: (result.gateResults ?? [])
        .filter((gate) => !gate.passed)
        .map((gate) => name(gate.id)),
      soft: (result.thresholdResults ?? [])
        .filter((entry) => !entry.passed)
        .map((entry) => name(entry.id)),
      turn,
      steps,
      error,
    };
  } finally {
    await engine.close();
  }
}
