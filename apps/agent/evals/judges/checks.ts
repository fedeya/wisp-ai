// Checks for failure modes found by reviewing real Wisp chats (error discovery,
// 2026-11-23). Each one answers one objective question about a turn, so it runs
// in code instead of an LLM judge.
import { createJudge, toolCalls } from 'vitest-evals';
import type { HarnessRun } from 'vitest-evals';
import type { WispInput } from '../runtime/harness.ts';

export interface ToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

/** What a check sees of one agent turn. */
export interface TurnView {
  reply: string;
  toolCalls: ToolCall[];
}

/** The view of an eval run that the checks read. */
export function turnView(run: HarnessRun<{ reply: string }>): TurnView {
  return {
    reply: run.output.reply,
    toolCalls: toolCalls(run).map((call) => ({
      name: call.name,
      input: call.arguments,
      output: call.status === 'ok' ? call.result : undefined,
    })),
  };
}

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

// The fields of a present_ui node (contract/ui-schema.ts) that the addon
// displays. Hidden fields, such as a button's ask prompt or node IDs, are not
// part of the answer.
type PanelNode = {
  kind?: string;
  title?: string;
  text?: string;
  label?: string;
  value?: unknown;
  detail?: string;
  reference?: string;
  winnerLabel?: string;
  columns?: Array<{ label?: string }>;
  rows?: string[][];
  items?: Array<{ label?: string; detail?: string }>;
  options?: Array<{ value?: string; label?: string }>;
};
function displayed(node: PanelNode, refs: Record<string, Reference>): string[] {
  const texts = [node.title];
  switch (node.kind) {
    case 'text':
      texts.push(node.text);
      break;
    case 'table':
      texts.push((node.columns ?? []).map((column) => column.label).join(' | '));
      // A table row stays one line, so a cell that turns an item down still
      // applies to the item named in another cell.
      texts.push(...(node.rows ?? []).map((row) => row.join(' | ')));
      break;
    case 'comparison':
      texts.push(...(node.items ?? []).flatMap((item) => [item.label, item.detail]));
      texts.push(node.winnerLabel);
      break;
    case 'stat':
      texts.push(node.label, String(node.value ?? ''), node.detail);
      break;
    case 'reference':
      texts.push(node.reference ? refs[node.reference]?.label : undefined);
      break;
    case 'select':
      texts.push(node.label, node.options?.find((option) => option.value === node.value)?.label);
      break;
    case 'button':
    case 'toggle':
    case 'slider':
    case 'progress':
      texts.push(node.label);
      break;
  }
  return texts.filter((text): text is string => Boolean(text));
}

/**
 * What the player reads: the reply, then each displayed text of its present_ui
 * panels on its own line (a table row as one line), with [[ref:key]] links and
 * reference cards shown by their labels, so sentence checks such as
 * recommendedByName see a linked item together with the words around it.
 */
export function visibleText(turn: TurnView): string {
  const refs = references(turn);
  const texts: string[] = [turn.reply];
  for (const call of turn.toolCalls) {
    if (call.name === 'wisp__present_ui') {
      // Only the panel is shown; the reference catalog is not text.
      const { nodes } = call.input as { nodes?: PanelNode[] };
      texts.push(...(nodes ?? []).flatMap((node) => displayed(node, refs)));
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

/** A scorer every case lists: headings and list items start on their own lines. */
export const keepsFormatting = () =>
  createJudge<WispInput, { reply: string }>(
    'keeps headings and lists on their own lines',
    ({ output: { reply } }) => ({ score: Number(gluedFormatting(reply).length === 0) }),
  );
