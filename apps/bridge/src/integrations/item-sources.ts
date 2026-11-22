import { callEverloot } from './everloot.ts';

// How an item is obtained, by Everloot relation. Other relations (reagent for,
// same icon, set membership) do not say where to get the item.
const OBTAIN = {
  dropped_by: 'drops',
  sold_by: 'vendors',
  reward_from: 'quests',
  created_by: 'crafted',
  located_in: 'containers',
} as const;
type SourceKind = (typeof OBTAIN)[keyof typeof OBTAIN];

interface Edge {
  rel?: string;
  toKind?: string;
  toId?: number;
  evidence?: string;
  installs?: number | null;
  lastSeen?: string;
}
interface Named {
  id: number;
  name?: string;
  subName?: string;
  zones?: string[];
  requiredLevel?: number;
  questLevel?: number;
}
interface Price {
  itemId: number;
  status?: string;
  unitPriceCopper?: number;
  ageDays?: number;
}
interface SourceNames {
  npcs?: Named[];
  quests?: Named[];
  spells?: Named[];
  prices?: Price[];
  priceStatus?: string;
  realm?: string;
}

async function relations(id: number, fetcher: typeof fetch, signal?: AbortSignal) {
  try {
    const content = await callEverloot(
      'entity_relations',
      { kind: 'item', id, direction: 'from', limit: 10 },
      fetcher,
      signal,
    );
    const edges: Edge[] = Array.isArray(content.page?.edges) ? content.page.edges : [];
    // Everloot caps lines per relation, so an obtain relation is never missing
    // entirely; notShown counts extra lines the agent may want to know about.
    const notShown = Number.isInteger(content.page?.notShown) ? content.page.notShown : 0;
    return { edges, notShown, status: 'available' as const };
  } catch {
    return { edges: [] as Edge[], notShown: 0, status: 'unavailable' as const };
  }
}

// One call for several items: observed and game-file sources from Everloot,
// named by the game (QuestieDB, spell API) with cached Auctionator prices.
export async function itemSources(
  itemIds: number[],
  readGame: (inspection: { kind: 'source_names'; args: unknown }) => Promise<unknown>,
  options: {
    everloot: boolean;
    questie: boolean;
    auctionator: boolean;
    fetch?: typeof fetch;
    signal?: AbortSignal;
  },
) {
  const ids = [...new Set(itemIds)];
  const found = options.everloot
    ? await Promise.all(ids.map((id) => relations(id, options.fetch ?? fetch, options.signal)))
    : ids.map(() => ({ edges: [] as Edge[], notShown: 0, status: 'disabled' as const }));
  const wanted = { npc: new Set<number>(), quest: new Set<number>(), spell: new Set<number>() };
  for (const { edges } of found) {
    for (const edge of edges) {
      const target = edge.toKind as keyof typeof wanted;
      if (edge.rel && edge.rel in OBTAIN && target in wanted && Number.isInteger(edge.toId)) {
        wanted[target].add(edge.toId!);
      }
    }
  }
  const reading = (await readGame({
    kind: 'source_names',
    // Questie names and Auctionator prices follow their own integration settings.
    args: {
      itemIds: options.auctionator ? ids : [],
      npcIds: options.questie ? [...wanted.npc].slice(0, 200) : [],
      questIds: options.questie ? [...wanted.quest].slice(0, 200) : [],
      spellIds: [...wanted.spell].slice(0, 200),
      useQuestie: options.questie,
    },
  })) as { data?: SourceNames; status?: string; error?: string };
  const names = reading?.data ?? {};
  const byId = (list: Named[] | undefined) =>
    new Map((list ?? []).map((entry) => [entry.id, entry]));
  const npcs = byId(names.npcs);
  const quests = byId(names.quests);
  const spells = byId(names.spells);
  const prices = new Map((names.prices ?? []).map((price) => [price.itemId, price]));
  const items = ids.map((id, index) => {
    const sources: Partial<Record<SourceKind, unknown[]>> = {};
    for (const edge of found[index]!.edges) {
      const kind = edge.rel ? OBTAIN[edge.rel as keyof typeof OBTAIN] : undefined;
      if (!kind || !Number.isInteger(edge.toId)) {
        continue;
      }
      const named =
        edge.toKind === 'npc'
          ? npcs.get(edge.toId!)
          : edge.toKind === 'quest'
            ? quests.get(edge.toId!)
            : edge.toKind === 'spell'
              ? spells.get(edge.toId!)
              : undefined;
      (sources[kind] ??= []).push({
        kind: edge.toKind,
        ...named,
        id: edge.toId,
        evidence: edge.evidence === 'observed' ? 'player-observed' : 'game files, unconfirmed',
        ...(edge.installs ? { installs: edge.installs, lastSeen: edge.lastSeen } : {}),
      });
    }
    const price = prices.get(id);
    return {
      itemId: id,
      ...sources,
      auction:
        price?.status === 'available'
          ? { unitPriceCopper: price.unitPriceCopper, ageDays: price.ageDays }
          : undefined,
      sourceKnown: Object.keys(sources).length > 0,
      sourcesStatus: found[index]!.status,
      ...(found[index]!.notShown ? { moreSourcesNotShown: found[index]!.notShown } : {}),
    };
  });
  return {
    status: 'available',
    items,
    priceStatus: names.priceStatus ?? 'unavailable',
    realm: names.realm,
    sources: {
      everloot: options.everloot ? 'https://everloot.app/database/items' : 'disabled in Settings',
      names: options.questie
        ? 'QuestieDB Forever and the game API'
        : 'game API only (Questie disabled in Settings)',
      prices: options.auctionator
        ? 'Auctionator public API (last seen, not live listings)'
        : 'disabled in Settings',
    },
    note: 'Player-observed sources need 3 agreeing installs; game-file sources are unconfirmed. sourceKnown=false means no known source, not proof the item is unobtainable. Auction prices are cached unit prices in copper.',
  };
}
