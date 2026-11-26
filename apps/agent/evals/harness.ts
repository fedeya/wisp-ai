// Runs one eval as a real engine turn: fixture stubs answer game and
// integration tools, gates must pass and scorers are tracked as warnings.
import { isDeepStrictEqual } from 'node:util';
import { createAgentEngine, type EngineEvent, type ToolStubOutcome } from '../src/engine.ts';
import { agentHost } from '../src/host/agent-host.ts';
import { MemoryHistory } from '../src/session/memory-history.ts';
import { commonScorers, eventsView, type Check, type TurnView } from './checks.ts';
import { playerMessage } from './fixtures/fedrath.ts';

/**
 * A rule for one input field: equal to `const`, a string matching the regular
 * expression `pattern`, or an array with an element that meets `contains`.
 */
export type MatchRule = { const: unknown } | { pattern: string } | { contains: MatchRule };

function meets(value: unknown, rule: MatchRule): boolean {
  if ('pattern' in rule) {
    return typeof value === 'string' && new RegExp(rule.pattern).test(value);
  }
  if ('contains' in rule) {
    return Array.isArray(value) && value.some((element) => meets(element, rule.contains));
  }
  return isDeepStrictEqual(value, rule.const);
}

/** Answers a tool from a fixture; the first stub whose tool and `match` fit wins. */
export interface ToolStub {
  id: string;
  tool: string;
  /** Input fields and the rule each must meet. */
  match?: Record<string, MatchRule>;
  outcome: ToolStubOutcome;
}

export interface EvalDefinition {
  description: string;
  tags?: string[];
  /** What the player asks; it is sent with the fixture character's game context. */
  question: string;
  stubs: ToolStub[];
  /** Hard requirements: the eval fails when one does not hold. */
  gates: Check[];
  /** Soft requirements: reported when one does not hold. */
  scorers?: Check[];
}
export const defineEval = (definition: EvalDefinition) => definition;

export function matches(stub: ToolStub, tool: string, input: unknown) {
  if (stub.tool !== tool) {
    return false;
  }
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return Object.entries(stub.match ?? {}).every(([key, rule]) => meets(fields[key], rule));
}

export interface EvalOutcome {
  /** failed: a gate or the turn failed; scored: only scorers missed. */
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
    history: new MemoryHistory(),
    logger: { info: () => {}, warn: () => {} },
    stub: (tool, input) => definition.stubs.find((stub) => matches(stub, tool, input))?.outcome,
  });
  try {
    const run = engine.send(
      engine.newSessionId(),
      playerMessage(definition.question),
      AbortSignal.timeout(300_000),
      'eval',
    );
    const events: EngineEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    const result = await run.result;
    const turn = eventsView(events);
    const failed = definition.gates.filter((check) => !check.test(turn)).map(({ name }) => name);
    const soft = [...commonScorers(), ...(definition.scorers ?? [])]
      .filter((check) => !check.test(turn))
      .map(({ name }) => name);
    const error =
      result.status === 'completed' ? undefined : (result.error?.message ?? 'cancelled');
    return {
      verdict: failed.length || error ? 'failed' : soft.length ? 'scored' : 'passed',
      failed,
      soft,
      turn,
      // The engine records usage once per model step.
      steps: events.filter((event) => event.type === 'usage.recorded').length,
      error,
    };
  } finally {
    await engine.close();
  }
}
