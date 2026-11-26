import { expect, test } from 'vitest';
import { itemSources } from '../src/integrations/item-sources.ts';
import type { EverlootLookup } from '@wisp/agent/mcp-manager';

function everloot(edges: Record<number, unknown[]>, failing: number[] = []) {
  const calls: number[] = [];
  const readEverloot: EverlootLookup = async (tool, args) => {
    expect(tool).toBe('entity_relations');
    const id = Number(args.id);
    calls.push(id);
    if (failing.includes(id)) {
      throw Error('Everloot unavailable');
    }
    return { page: { kind: 'item', id, edges: edges[id] ?? [] } };
  };
  return { readEverloot, calls };
}

const names = {
  status: 'available',
  data: {
    npcs: [{ id: 2266, name: 'Gnoll Brute', zones: ['Westfall'] }],
    quests: [{ id: 875, name: 'Harpy Raiders', requiredLevel: 14 }],
    spells: [{ id: 3855, name: 'Spidersilk Boots' }],
    prices: [
      { itemId: 4320, status: 'available', unitPriceCopper: 7000, ageDays: 0 },
      { itemId: 15700, status: 'unknown' },
    ],
    priceStatus: 'available',
    realm: 'Vorn',
  },
};

test('sources for several items are read together and named in one game request', async () => {
  const { readEverloot, calls } = everloot({
    4320: [
      { rel: 'created_by', toKind: 'spell', toId: 3855, evidence: 'client' },
      { rel: 'same_icon', toKind: 'icon', toId: 132539, evidence: 'client' },
      { rel: 'reagent_for', toKind: 'spell', toId: 429351, evidence: 'client' },
    ],
    2589: [
      {
        rel: 'dropped_by',
        toKind: 'npc',
        toId: 2266,
        evidence: 'observed',
        installs: 3,
        lastSeen: '2026-11-19T14:53:31.000Z',
      },
      { rel: 'reward_from', toKind: 'quest', toId: 875, evidence: 'observed', installs: 4 },
    ],
  });
  const reads: unknown[] = [];
  const result = await itemSources(
    [4320, 2589, 15700, 4320],
    async (inspection) => {
      reads.push(inspection);
      return names;
    },
    { everloot: true, questie: true, auctionator: true, readEverloot },
  );
  expect(calls.sort((a, b) => a - b)).toEqual([2589, 4320, 15700]);
  expect(reads).toEqual([
    {
      kind: 'source_names',
      args: {
        itemIds: [4320, 2589, 15700],
        npcIds: [2266],
        questIds: [875],
        spellIds: [3855],
        useQuestie: true,
      },
    },
  ]);
  const [boots, linen, ring] = result.items as Array<Record<string, any>>;
  expect(boots).toMatchObject({
    itemId: 4320,
    sourceKnown: true,
    crafted: [
      { kind: 'spell', id: 3855, name: 'Spidersilk Boots', evidence: 'game files, unconfirmed' },
    ],
    auction: { unitPriceCopper: 7000, ageDays: 0 },
  });
  expect(boots.vendors).toBeUndefined();
  expect(linen).toMatchObject({
    drops: [
      {
        id: 2266,
        name: 'Gnoll Brute',
        zones: ['Westfall'],
        evidence: 'player-observed',
        installs: 3,
      },
    ],
    quests: [{ name: 'Harpy Raiders', requiredLevel: 14 }],
  });
  expect(ring).toMatchObject({ itemId: 15700, sourceKnown: false, auction: undefined });
});

test('Everloot failures or a disabled integration still return prices', async () => {
  const { readEverloot } = everloot({}, [4320]);
  const failed = await itemSources([4320], async () => names, {
    everloot: true,
    questie: true,
    auctionator: true,
    readEverloot,
  });
  expect(failed.items[0]).toMatchObject({ sourcesStatus: 'unavailable', sourceKnown: false });
  expect(failed.items[0]!.auction).toEqual({ unitPriceCopper: 7000, ageDays: 0 });

  const { readEverloot: unused, calls } = everloot({});
  const disabled = await itemSources([4320], async () => names, {
    everloot: false,
    questie: true,
    auctionator: true,
    readEverloot: unused,
  });
  expect(calls).toEqual([]);
  expect(disabled.items[0]).toMatchObject({ sourcesStatus: 'disabled' });
  expect(disabled.sources.everloot).toBe('disabled in Settings');
});

test('disabled Questie and Auctionator settings keep their reads out of the game request', async () => {
  const { readEverloot } = everloot({
    2589: [{ rel: 'dropped_by', toKind: 'npc', toId: 2266, evidence: 'observed', installs: 3 }],
  });
  const reads: unknown[] = [];
  const result = await itemSources(
    [2589],
    async (inspection) => {
      reads.push(inspection);
      return { status: 'available', data: { npcs: [], quests: [], spells: [] } };
    },
    { everloot: true, questie: false, auctionator: false, readEverloot },
  );
  expect(reads).toEqual([
    {
      kind: 'source_names',
      args: { itemIds: [], npcIds: [], questIds: [], spellIds: [], useQuestie: false },
    },
  ]);
  expect(result.items[0]).toMatchObject({ drops: [{ kind: 'npc', id: 2266 }] });
  expect(result.sources.prices).toBe('disabled in Settings');
});

test('relations beyond the Everloot per-relation limit are reported', async () => {
  const readEverloot = async () => ({
    page: {
      edges: [{ rel: 'dropped_by', toKind: 'npc', toId: 1, evidence: 'observed' }],
      notShown: 7,
    },
  });
  const result = await itemSources([2589], async () => names, {
    everloot: true,
    questie: true,
    auctionator: true,
    readEverloot,
  });
  expect(result.items[0]).toMatchObject({ sourceKnown: true, moreSourcesNotShown: 7 });
});
