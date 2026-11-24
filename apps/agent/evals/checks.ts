// Deterministic checks as Mastra scorers. Each scores a turn 1 or 0 from the
// agent's output messages. Deferred tools run through tool_call, so checks see
// the tool it ran, not the proxy.
import { isDeepStrictEqual } from 'node:util';
import { createScorer } from '@mastra/core/evals';
import { TOOL_CALL } from '../src/engine.ts';

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

interface Invocation {
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

function unwrap(name: string, input: unknown, output?: unknown): ToolCall {
  const proxy = input as { name?: unknown; input?: unknown } | undefined;
  return name === TOOL_CALL && typeof proxy?.name === 'string'
    ? { name: proxy.name, input: proxy.input ?? {}, output }
    : { name, input, output };
}

function view(reply: string, toolCalls: ToolCall[]): TurnView {
  const panels = toolCalls.filter((call) => call.name === 'wisp__present_ui');
  return { reply, toolCalls, presented: reply + JSON.stringify(panels.map((call) => call.input)) };
}

/** The view of a scorer run: Mastra's stored assistant messages. */
export function messagesView(messages: unknown): TurnView {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const parts = (message as { content?: { parts?: Record<string, unknown>[] } }).content?.parts;
    for (const part of parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      } else if (part.type === 'tool-invocation') {
        const call = part.toolInvocation as Invocation;
        toolCalls.push(unwrap(String(call.toolName), call.args, call.result));
      }
    }
  }
  return view(texts.join('\n\n'), toolCalls);
}

/** The view of an agent result, as runEvals reports each item. */
export function resultView(result: {
  text?: string;
  toolCalls?: { payload?: { toolCallId?: string; toolName?: string; args?: unknown } }[];
  toolResults?: { payload?: { toolCallId?: string; result?: unknown } }[];
}): TurnView {
  const outputs = new Map(
    (result.toolResults ?? []).map((entry) => [entry.payload?.toolCallId, entry.payload?.result]),
  );
  return view(
    result.text ?? '',
    (result.toolCalls ?? []).map((entry) =>
      unwrap(
        String(entry.payload?.toolName),
        entry.payload?.args,
        outputs.get(entry.payload?.toolCallId),
      ),
    ),
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

let checks = 0;
/** A check named by what it expects; scores 1 when `test` holds. */
export function expects(label: string, test: (turn: TurnView) => boolean) {
  return createScorer({
    id:
      'check-' +
      ++checks +
      '-' +
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40),
    name: label,
    description: label,
    type: 'agent',
  }).generateScore(({ run }) => (test(messagesView(run.output)) ? 1 : 0));
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
