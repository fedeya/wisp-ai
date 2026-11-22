import type { z } from 'zod';
import {
  typelessArmorSlots,
  type armorSearchInput,
  type weaponSearchInput,
} from '@wisp/protocol/game-inspection';

const EVERLOOT_MCP = 'https://everloot.app/mcp/public';
// Everloot lists at most 100 items per call; one call per quality keeps every
// slot/type listing checked so far (all under 100 per quality) complete.
const PAGE = 100;

type ArmorSearch = z.output<typeof armorSearchInput>;
type WeaponSearch = z.output<typeof weaponSearchInput>;
export type GearSearch =
  | { kind: 'search_armor'; args: ArmorSearch }
  | { kind: 'search_weapons'; args: WeaponSearch };

interface Category {
  class: string;
  subclass: string;
  slot?: string;
}
export function gearCategory(search: GearSearch): Category {
  if (search.kind === 'search_armor') {
    const { slot, armorType } = search.args;
    if (typelessArmorSlots.includes(slot)) {
      // Cloaks are cloth in the game files whatever the wearer's armor type.
      return { class: 'armor', subclass: slot === 'back' ? 'cloth' : 'miscellaneous', slot };
    }
    return { class: 'armor', subclass: armorType!, slot };
  }
  const { weaponType } = search.args;
  if (weaponType === 'shields') {
    return { class: 'armor', subclass: 'shields', slot: 'shield' };
  }
  if (weaponType === 'held-in-off-hand') {
    return { class: 'armor', subclass: 'miscellaneous', slot: 'held-in-off-hand' };
  }
  return { class: 'weapons', subclass: weaponType };
}

interface CategoryPage {
  itemIds: number[];
  total: number;
  build?: string;
  label?: string;
  credit?: string;
}
async function listCategory(
  category: Category,
  quality: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CategoryPage> {
  const response = await fetcher(EVERLOOT_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'item_categories', arguments: { ...category, quality, limit: PAGE } },
    }),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error('Everloot item catalog returned HTTP ' + response.status);
  }
  const text = await response.text();
  // Streamable HTTP servers may answer with one SSE event instead of JSON.
  const json = JSON.parse(text.trimStart().startsWith('{') ? text : text.split('data:')[1] || '');
  const result = json?.result;
  if (json?.error || result?.isError || !result?.structuredContent) {
    throw new Error('Everloot item catalog could not list this category');
  }
  const content = result.structuredContent;
  const itemIds = Array.isArray(content.items)
    ? content.items
        .map((item: { itemId?: unknown }) => item.itemId)
        .filter((id: unknown): id is number => Number.isInteger(id) && (id as number) > 0)
    : [];
  return {
    itemIds,
    total: Number.isInteger(content.total) ? content.total : itemIds.length,
    build: typeof content.build === 'string' ? content.build : undefined,
    label: typeof content.label === 'string' ? content.label : undefined,
    credit: typeof content.credit === 'string' ? content.credit : undefined,
  };
}

// Lists real catalog IDs for the requested category, then lets the game read,
// filter by level and compare them. Choosing among the results is the agent's.
export async function searchGear(
  search: GearSearch,
  readGame: (inspection: { kind: 'gear_candidates'; args: unknown }) => Promise<unknown>,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const category = gearCategory(search);
  const qualities = [...new Set(search.args.quality)];
  const pages = await Promise.all(
    qualities.map((quality) =>
      listCategory(category, quality, options.fetch ?? fetch, options.signal),
    ),
  );
  const itemIds = [...new Set(pages.flatMap((page) => page.itemIds))];
  const first = pages.find((page) => page.build);
  const catalog = {
    source: 'Everloot item_categories',
    label: first?.label,
    build: first?.build,
    credit: first?.credit,
    url: 'https://everloot.app/database/items',
    category,
    listed: itemIds.length,
    byQuality: Object.fromEntries(
      qualities.map((quality, index) => [
        quality,
        { total: pages[index]!.total, listed: pages[index]!.itemIds.length },
      ]),
    ),
    incomplete: pages.some((page) => page.total > page.itemIds.length),
  };
  if (!itemIds.length) {
    return { status: 'available', catalog, data: { items: [], counts: { requested: 0 } } };
  }
  const reading = await readGame({
    kind: 'gear_candidates',
    args: {
      itemIds,
      minRequiredLevel: search.args.minRequiredLevel,
      maxRequiredLevel: search.args.maxRequiredLevel,
    },
  });
  return { catalog, ...(reading as Record<string, unknown>) };
}
