// Deterministic checks of one agent turn, read from the engine's own events.
// Deferred tools run through tool_call, and the engine reports each call as the
// tool it ran, so checks see that tool, not the proxy.
import { isDeepStrictEqual } from 'node:util';
import type { EngineEvent } from '../src/engine.ts';

export interface ToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

/** What a check sees of one agent turn. */
export interface TurnView {
  reply: string;
  toolCalls: ToolCall[];
  /** The reply plus its registered presentation panels, where Wisp names items. */
  presented: string;
}

/** A named expectation about a turn. */
export interface Check {
  name: string;
  test: (turn: TurnView) => boolean;
}

/** The view of a turn from the events the bridge would receive. */
export function eventsView(events: EngineEvent[]): TurnView {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const calls = new Map<string, ToolCall>();
  for (const { type, data } of events) {
    if (type === 'content.completed' && data.kind === 'text') {
      texts.push(String(data.value));
    } else if (type === 'call.requested') {
      const call = { name: String((data.capability as { name: string }).name), input: data.input };
      calls.set(String(data.callId), call);
      toolCalls.push(call);
    } else if (type === 'call.settled' && data.outcome === 'completed') {
      const call = calls.get(String(data.callId));
      if (call) {
        call.output = data.output;
      }
    }
  }
  const reply = texts.join('\n\n');
  const panels = toolCalls.filter((call) => call.name === 'wisp__present_ui');
  return { reply, toolCalls, presented: reply + JSON.stringify(panels.map((call) => call.input)) };
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

/** A check named by what it expects; it passes when `test` holds. */
export function expects(name: string, test: (turn: TurnView) => boolean): Check {
  return { name, test };
}

export const replied = () =>
  expects('the turn ends with a reply', (turn) => turn.reply.trim().length > 0);

export const calledTool = (
  name: string,
  options: { input?: Record<string, unknown>; count?: number } = {},
) =>
  expects(
    'called ' +
      name +
      (options.input ? ' with ' + JSON.stringify(options.input) : '') +
      (options.count !== undefined ? ' ' + options.count + ' time(s)' : ''),
    (turn) => {
      const found = turn.toolCalls.filter(
        (call) => call.name === name && (!options.input || includes(call.input, options.input)),
      ).length;
      return options.count !== undefined ? found === options.count : found > 0;
    },
  );

export const notCalledTool = (name: string) =>
  expects('did not call ' + name, (turn) => !turn.toolCalls.some((call) => call.name === name));

export const maxToolCalls = (count: number) =>
  expects(`at most ${count} tool calls`, (turn) => turn.toolCalls.length <= count);
