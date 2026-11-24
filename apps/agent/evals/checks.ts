// Code checks for failure modes found by reviewing real Wisp chats (error
// discovery, 2026-11-23). Each one answers one objective question about a
// turn, so it runs as an eval gate instead of an LLM judge.
import { satisfies } from 'eve/evals/expect';

interface Turn {
  reply?: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown; output?: unknown }>;
}
interface Checks {
  check(value: unknown, matcher: ReturnType<typeof satisfies>): { soft(): unknown };
}

// Item IDs the reply presents as references ([[ref:key]] with kind item).
export function presentedItemIds(turn: Turn): number[] {
  const ids: number[] = [];
  for (const call of turn.toolCalls) {
    if (call.name !== 'wisp__present_ui') continue;
    const { references } = call.input as {
      references?: Record<string, { kind?: string; id?: number }>;
    };
    for (const reference of Object.values(references ?? {})) {
      if (reference.kind === 'item' && typeof reference.id === 'number') ids.push(reference.id);
    }
  }
  return ids;
}

// Broken formatting: a heading, bold lead or list item glued to the previous
// sentence, as in "15 seconds.### What I'd use" or "rinde.- **Compraría:**".
export function gluedFormatting(reply: string): string[] {
  const patterns = [/[^\n#]#{2,6} \S/g, /[.!?:]- \*\*/g, /[.!?]\*\*[A-ZÁÉÍÓÚÑ¿¡]/g];
  return patterns.flatMap((pattern) => reply.match(pattern) ?? []);
}

// Unobtainable gear: items whose only known source is a profession recipe and
// that have no auction price, according to the wow__item_sources results.
export function craftOnlyItems(turn: Turn): Set<number> {
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
  /\b(skip|avoid|don['’]?t|do not|can['’]?t|cannot|won['’]?t|unavailable|out of reach|not available|without|needs? Tailoring|requires? Tailoring|instead of)\b/i;
export function recommendedByName(reply: string, names: RegExp): string[] {
  return reply
    .split(/\n|(?<=[.!?])\s+/)
    .filter((sentence) => names.test(sentence) && !TURNED_DOWN.test(sentence));
}

// Checks every eval shares.
export function commonChecks(t: Checks, turn: Turn) {
  t.check(
    turn.reply ?? '',
    satisfies(
      (text: string) => gluedFormatting(text).length === 0,
      'keeps headings and lists on their own lines',
    ),
  ).soft();
}
