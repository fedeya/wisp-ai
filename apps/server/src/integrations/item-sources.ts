import { Option, Schema } from 'effect';
import type { Lookup as EverlootLookup } from '@wisp/agent/everloot';
import type { ItemSourcesResult } from '@wisp/agent/game-access';
import type { sourceNamesInput } from '@wisp/agent/contract/game-inspection';
import type { z } from 'zod';

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

const obtain = new Map<string, SourceKind>(Object.entries(OBTAIN));
const edge = Schema.Struct({
  rel: Schema.String,
  toKind: Schema.optional(Schema.String),
  toId: Schema.Int,
  evidence: Schema.optional(Schema.String),
  installs: Schema.optional(Schema.NullOr(Schema.Number)),
  lastSeen: Schema.optional(Schema.String),
});
const decodeEdge = Schema.decodeUnknownOption(edge);
const decodePage = Schema.decodeUnknownOption(
  Schema.Struct({
    edges: Schema.optional(Schema.Array(Schema.Unknown)),
    notShown: Schema.optional(Schema.Int),
  }),
);
const namedEntity = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.String),
  subName: Schema.optional(Schema.String),
  zones: Schema.optional(Schema.Array(Schema.String)),
  requiredLevel: Schema.optional(Schema.Number),
  questLevel: Schema.optional(Schema.Number),
});
const namedEntities = Schema.optional(Schema.Array(namedEntity));
const decodeSourceNames = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.optional(
      Schema.Struct({
        npcs: namedEntities,
        quests: namedEntities,
        spells: namedEntities,
        prices: Schema.optional(
          Schema.Array(
            Schema.Struct({
              itemId: Schema.Int,
              status: Schema.optional(Schema.String),
              unitPriceCopper: Schema.optional(Schema.Number),
              ageDays: Schema.optional(Schema.Number),
            }),
          ),
        ),
        priceStatus: Schema.optional(Schema.String),
        realm: Schema.optional(Schema.String),
      }),
    ),
  }),
);
type ItemSource = NonNullable<ItemSourcesResult['items'][number]['drops']>[number];
type Relations = {
  itemId: number;
  edges: readonly (typeof edge.Type)[];
  notShown: number;
  status: ItemSourcesResult['items'][number]['sourcesStatus'];
};

async function relations(itemId: number, readEverloot: EverlootLookup): Promise<Relations> {
  const unavailable: Relations = { itemId, edges: [], notShown: 0, status: 'unavailable' };
  try {
    const content = await readEverloot('entity_relations', {
      kind: 'item',
      id: itemId,
      direction: 'from',
      limit: 10,
    });
    const page = Option.getOrUndefined(decodePage(content.page));
    if (!page) return unavailable;
    const edges = (page.edges ?? []).flatMap((entry) => Option.toArray(decodeEdge(entry)));
    // Everloot caps lines per relation, so an obtain relation is never missing
    // entirely; notShown counts extra lines the agent may want to know about.
    return { itemId, edges, notShown: page.notShown ?? 0, status: 'available' };
  } catch {
    return unavailable;
  }
}

// One call for several items: observed and game-file sources from Everloot,
// named by the game (QuestieDB, spell API) with cached Auctionator prices.
export async function itemSources(
  itemIds: number[],
  readGame: (inspection: {
    kind: 'source_names';
    args: z.output<typeof sourceNamesInput>;
  }) => Promise<unknown>,
  options: {
    everloot: boolean;
    questie: boolean;
    auctionator: boolean;
    readEverloot: EverlootLookup;
  },
): Promise<ItemSourcesResult> {
  const ids = [...new Set(itemIds)];
  const found: Relations[] = options.everloot
    ? await Promise.all(ids.map((id) => relations(id, options.readEverloot)))
    : ids.map((itemId) => ({ itemId, edges: [], notShown: 0, status: 'disabled' }));
  const wanted = { npc: new Set<number>(), quest: new Set<number>(), spell: new Set<number>() };
  for (const { edges } of found) {
    for (const edge of edges) {
      const target = edge.toKind;
      if (obtain.has(edge.rel) && (target === 'npc' || target === 'quest' || target === 'spell')) {
        wanted[target].add(edge.toId);
      }
    }
  }
  const reading = await readGame({
    kind: 'source_names',
    // Questie names and Auctionator prices follow their own integration settings.
    args: {
      itemIds: options.auctionator ? ids : [],
      npcIds: options.questie ? [...wanted.npc].slice(0, 200) : [],
      questIds: options.questie ? [...wanted.quest].slice(0, 200) : [],
      spellIds: [...wanted.spell].slice(0, 200),
      useQuestie: options.questie,
    },
  });
  const names = decodeSourceNames(reading ?? {}).data ?? {};
  const byId = (list: readonly (typeof namedEntity.Type)[] | undefined) =>
    new Map((list ?? []).map((entry) => [entry.id, entry]));
  const npcs = byId(names.npcs);
  const quests = byId(names.quests);
  const spells = byId(names.spells);
  const prices = new Map((names.prices ?? []).map((price) => [price.itemId, price]));
  const items = found.map(({ itemId, edges, status, notShown }) => {
    const sources: Partial<Record<SourceKind, ItemSource[]>> = {};
    for (const edge of edges) {
      const kind = obtain.get(edge.rel);
      if (!kind) {
        continue;
      }
      const named =
        edge.toKind === 'npc'
          ? npcs.get(edge.toId)
          : edge.toKind === 'quest'
            ? quests.get(edge.toId)
            : edge.toKind === 'spell'
              ? spells.get(edge.toId)
              : undefined;
      (sources[kind] ??= []).push({
        kind: edge.toKind,
        ...named,
        id: edge.toId,
        evidence: edge.evidence === 'observed' ? 'player-observed' : 'game files, unconfirmed',
        ...(edge.installs ? { installs: edge.installs, lastSeen: edge.lastSeen } : {}),
      });
    }
    const price = prices.get(itemId);
    return {
      itemId,
      ...sources,
      auction:
        price?.status === 'available'
          ? { unitPriceCopper: price.unitPriceCopper, ageDays: price.ageDays }
          : undefined,
      sourceKnown: Object.keys(sources).length > 0,
      sourcesStatus: status,
      ...(notShown ? { moreSourcesNotShown: notShown } : {}),
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
