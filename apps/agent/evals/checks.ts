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

// Checks for failure modes found by reviewing real Wisp chats (error discovery,
// 2026-11-23). Each one answers one objective question about a turn, so it runs
// as a gate or scorer instead of an LLM judge.

/**
 * Broken formatting: a heading, bold lead or list item glued to the previous
 * sentence, as in "15 seconds.### What I'd use" or "rinde.- **Compraría:**".
 */
export function gluedFormatting(reply: string): string[] {
  const patterns = [/[^\n#]#{2,6} \S/g, /[.!?:]- \*\*/g, /[.!?]\*\*[A-ZÁÉÍÓÚÑ¿¡]/g];
  return patterns.flatMap((pattern) => reply.match(pattern) ?? []);
}

/**
 * Unobtainable gear: items whose only known source is a profession recipe and
 * that have no auction price, according to the wow__item_sources results.
 */
export function craftOnlyItems(turn: TurnView): Set<number> {
  const craftOnly = new Set<number>();
  for (const call of turn.toolCalls) {
    if (call.name !== 'wow__item_sources') continue;
    const { items } = (call.output ?? {}) as { items?: Array<Record<string, unknown>> };
    for (const item of items ?? []) {
      const otherSource = ['drops', 'vendors', 'quests'].some(
        (kind) => Array.isArray(item[kind]) && (item[kind] as unknown[]).length > 0,
      );
      if (Array.isArray(item.crafted) && !otherSource && !item.auction) {
        craftOnly.add(Number(item.itemId));
      }
    }
  }
  return craftOnly;
}

// Sentences or table rows that name an item without turning it down, so
// "Skip Azure Silk Hood, you can't get it" does not count as recommending it.
const TURNED_DOWN =
  /\b(skip|avoid|don['’]?t|do not|can['’]?t|cannot|won['’]?t|unavailable|out of reach|not available|without|needs? Tailoring|requires? Tailoring)\b/i;
// In "Buy A instead of B" only B is turned down, so only the part before the
// comparison can recommend an item.
const PREFERRED_TO = /\b(?:instead of|rather than|in place of)\b/i;
export function recommendedByName(reply: string, names: RegExp): string[] {
  return reply.split(/\n|(?<=[.!?])\s+/).filter((sentence) => {
    const [kept = ''] = sentence.split(PREFERRED_TO);
    return names.test(kept) && !TURNED_DOWN.test(kept);
  });
}

/** Scorers every eval shares; the harness adds them to each eval's own. */
export const commonScorers = (): Check[] => [
  expects(
    'keeps headings and lists on their own lines',
    (turn) => gluedFormatting(turn.reply).length === 0,
  ),
];

type Reference = { kind?: string; id?: number; label?: string };

// The references the turn registered with present_ui, by key.
function references(turn: TurnView): Record<string, Reference> {
  const all: Record<string, Reference> = {};
  for (const call of turn.toolCalls) {
    if (call.name === 'wisp__present_ui') {
      Object.assign(all, (call.input as { references?: Record<string, Reference> }).references);
    }
  }
  return all;
}

/**
 * What the player reads: the reply, then each text of its present_ui panels on
 * its own line (a table row as one line), with [[ref:key]] links and reference
 * cards shown by their labels, so sentence checks such as recommendedByName see
 * a linked item together with the words around it.
 */
export function visibleText(turn: TurnView): string {
  const refs = references(turn);
  const texts: string[] = [turn.reply];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      texts.push(value);
    } else if (Array.isArray(value) && value.every((cell) => typeof cell === 'string')) {
      // A table row stays one line, so a cell that turns an item down still
      // applies to the item named in another cell.
      texts.push(value.join(' | '));
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === 'object') {
      const node = value as { kind?: string; reference?: string };
      if (node.kind === 'reference' && node.reference) {
        texts.push(refs[node.reference]?.label ?? '');
      }
      Object.values(value).forEach(collect);
    }
  };
  for (const call of turn.toolCalls) {
    if (call.name === 'wisp__present_ui') {
      // Only the panel is shown; the reference catalog is not text.
      collect((call.input as { nodes?: unknown }).nodes);
    }
  }
  return texts
    .join('\n')
    .replace(/\[\[ref:([^\]]+)\]\]/g, (link, key: string) => refs[key]?.label ?? link);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Item IDs the player is pointed to: linked or shown items whose label appears
 * in visible text that does not turn them down.
 */
export function recommendedItemIds(turn: TurnView): number[] {
  const text = visibleText(turn);
  return Object.values(references(turn))
    .filter((ref) => ref.kind === 'item' && typeof ref.id === 'number' && ref.label)
    .filter((ref) => recommendedByName(text, new RegExp(escape(ref.label!), 'i')).length > 0)
    .map((ref) => ref.id!);
}
