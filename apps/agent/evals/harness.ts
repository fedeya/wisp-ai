// A small eval harness for the agent engine: each eval sends real player
// messages to the real model through the eval bridge, while fixtures answer the
// game and integration tools. Run with `pnpm --filter @wisp/agent eval`.
import { isDeepStrictEqual } from 'node:util';
import {
  createAgentEngine,
  type EngineEvent,
  type ModelMessage,
  type ToolStubOutcome,
} from '../src/engine.ts';
import { agentHost } from '../src/agent-host.ts';

/** Answers a tool from a fixture; the first stub whose tool and `match` fit wins. */
export interface ToolStub {
  id: string;
  tool: string;
  /** Input fields that must equal `const`. */
  match?: Record<string, { const: unknown }>;
  outcome: ToolStubOutcome;
}

export interface ToolCall {
  name: string;
  input: unknown;
  status?: string;
  output?: unknown;
}

export interface Turn {
  ok: boolean;
  error?: string;
  reply?: string;
  events: EngineEvent[];
  toolCalls: ToolCall[];
  expectOk(): void;
}

interface Assertion {
  label: string;
  passed: boolean;
  soft: boolean;
}
export interface Soft {
  soft(): void;
}

export interface EvalContext {
  session(options: { stubs: ToolStub[] }): { send(message: string): Promise<Turn> };
  calledTool(name: string, options?: { input?: Record<string, unknown>; count?: number }): Soft;
  notCalledTool(name: string): Soft;
  maxToolCalls(count: number): Soft;
  check<T>(value: T, predicate: Predicate<T>): Soft;
}

export interface Predicate<T> {
  label: string;
  test: (value: T) => boolean;
}
export const satisfies = <T>(test: (value: T) => boolean, label: string): Predicate<T> => ({
  label,
  test,
});

export interface EvalDefinition {
  description: string;
  tags?: string[];
  test: (t: EvalContext) => Promise<void>;
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

// Whether every field of `expected` appears, recursively, in `actual`.
function includes(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        includes((actual as Record<string, unknown>)[key], value),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}

export async function runEval(definition: EvalDefinition) {
  const host = agentHost();
  if (!host) {
    throw Error('Start the eval bridge before running evals.');
  }
  const assertions: Assertion[] = [];
  const calls: ToolCall[] = [];
  const assert = (label: string, passed: boolean): Soft => {
    const assertion = { label, passed, soft: false };
    assertions.push(assertion);
    return { soft: () => void (assertion.soft = true) };
  };
  const context: EvalContext = {
    session({ stubs }) {
      const histories = new Map<string, ModelMessage[]>();
      const engine = createAgentEngine({
        origin: () => host.origin,
        token: host.token,
        history: {
          load: async (session) => [...(histories.get(session) ?? [])],
          append: async (session, from, messages) => {
            histories.set(session, [...(histories.get(session) ?? []).slice(0, from), ...messages]);
          },
          replace: async (session, messages) => void histories.set(session, [...messages]),
          delete: async (session) => void histories.delete(session),
        },
        logger: { info: () => {}, warn: () => {} },
        stub: (tool, input) => stubs.find((stub) => matches(stub, tool, input))?.outcome,
      });
      const session = engine.newSessionId();
      return {
        async send(message) {
          const turn = engine.send(session, message, AbortSignal.timeout(300_000));
          const events: EngineEvent[] = [];
          const turnCalls = new Map<string, ToolCall>();
          const texts = new Map<string, string>();
          for await (const event of turn.events) {
            events.push(event);
            const data = event.data;
            if (event.type === 'call.requested') {
              const capability = data.capability as { name: string };
              const call = { name: capability.name, input: data.input };
              turnCalls.set(String(data.callId), call);
              calls.push(call);
            } else if (event.type === 'call.settled') {
              const call = turnCalls.get(String(data.callId));
              if (call) {
                call.status = String(data.outcome);
                call.output = data.output;
              }
            } else if (event.type === 'content.completed') {
              texts.set(String(data.partId), String(data.value));
            }
          }
          const result = await turn.result;
          const reply = [...texts.values()].join('\n\n') || undefined;
          return {
            ok: result.status === 'completed',
            error: result.error?.message,
            reply,
            events,
            toolCalls: [...turnCalls.values()],
            expectOk() {
              assert(
                'turn completed' + (result.error ? ': ' + result.error.message : ''),
                result.status === 'completed',
              );
            },
          };
        },
      };
    },
    calledTool: (name, options) => {
      const found = calls.filter(
        (call) => call.name === name && (!options?.input || includes(call.input, options.input)),
      ).length;
      return assert(
        'called ' +
          name +
          (options?.input ? ' with ' + JSON.stringify(options.input) : '') +
          (options?.count !== undefined ? ' ' + options.count + ' time(s) (' + found + ')' : ''),
        options?.count !== undefined ? found === options.count : found > 0,
      );
    },
    notCalledTool: (name) =>
      assert('did not call ' + name, !calls.some((call) => call.name === name)),
    maxToolCalls: (count) =>
      assert(`at most ${count} tool calls (${calls.length})`, calls.length <= count),
    check: (value, predicate) => assert(predicate.label, predicate.test(value)),
  };
  let error: unknown;
  try {
    await definition.test(context);
  } catch (caught) {
    error = caught;
  }
  return { assertions, error };
}
