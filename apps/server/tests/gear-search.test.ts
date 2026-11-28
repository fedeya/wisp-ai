import { expect, test } from 'vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { armorSearchInput, weaponSearchInput } from '@wisp/agent/contract/game-inspection';
import { gearCategory, searchGear, type GearSearch } from '../src/integrations/gear-search.ts';
import type { Lookup as EverlootLookup } from '@wisp/agent/everloot';

const armor = (args: unknown): GearSearch => ({
  kind: 'search_armor',
  args: Schema.decodeUnknownSync(armorSearchInput)(args, rejectUnknownKeys),
});
const weapons = (args: unknown): GearSearch => ({
  kind: 'search_weapons',
  args: Schema.decodeUnknownSync(weaponSearchInput)(args, rejectUnknownKeys),
});

function catalog(pages: Record<string, { ids: number[]; total?: number }>) {
  const calls: Array<Record<string, unknown>> = [];
  const readEverloot: EverlootLookup = async (tool, args) => {
    expect(tool).toBe('item_categories');
    calls.push(args);
    const page = pages[String(args.quality)] ?? { ids: [] };
    return {
      label: 'found in game files, unconfirmed',
      build: '1.60.1.70959',
      items: page.ids.map((itemId) => ({ itemId })),
      total: page.total ?? page.ids.length,
    };
  };
  return { readEverloot, calls };
}

test('gear searches map onto the game-file categories', () => {
  expect(gearCategory(armor({ slot: 'feet', armorType: 'cloth' }))).toEqual({
    class: 'armor',
    subclass: 'cloth',
    slot: 'feet',
  });
  expect(gearCategory(armor({ slot: 'finger', armorType: 'plate' }))).toEqual({
    class: 'armor',
    subclass: 'miscellaneous',
    slot: 'finger',
  });
  expect(gearCategory(armor({ slot: 'back' }))).toEqual({
    class: 'armor',
    subclass: 'cloth',
    slot: 'back',
  });
  expect(gearCategory(weapons({ weaponType: 'wands' }))).toEqual({
    class: 'weapons',
    subclass: 'wands',
  });
  expect(gearCategory(weapons({ weaponType: 'shields' })).subclass).toBe('shields');
  expect(gearCategory(weapons({ weaponType: 'held-in-off-hand' })).slot).toBe('held-in-off-hand');
  const chest = Schema.decodeUnknownExit(armorSearchInput)({ slot: 'chest' }, rejectUnknownKeys);
  expect(Exit.isFailure(chest)).toBe(true);
});

test('a search lists every requested quality and reads the merged IDs from the game once', async () => {
  const { readEverloot, calls } = catalog({
    common: { ids: [1, 2] },
    uncommon: { ids: [2, 3], total: 120 },
    rare: { ids: [4] },
  });
  const reads: unknown[] = [];
  const result = await searchGear(
    armor({ slot: 'feet', armorType: 'cloth', maxRequiredLevel: 21 }),
    async (inspection) => {
      reads.push(inspection);
      return { status: 'available', data: { items: [{ id: 3 }] } };
    },
    readEverloot,
  );
  expect(calls.map((call) => call.quality)).toEqual(['common', 'uncommon', 'rare']);
  expect(calls[0]).toMatchObject({ class: 'armor', subclass: 'cloth', slot: 'feet', limit: 100 });
  expect(reads).toEqual([
    {
      kind: 'gear_candidates',
      args: { itemIds: [1, 2, 3, 4], minRequiredLevel: undefined, maxRequiredLevel: 21 },
    },
  ]);
  expect(result).toMatchObject({
    status: 'available',
    data: { items: [{ id: 3 }] },
    catalog: {
      listed: 4,
      build: '1.60.1.70959',
      incomplete: true,
      byQuality: { uncommon: { total: 120, listed: 2 } },
    },
  });
});

test('empty listings skip the game read', async () => {
  const { readEverloot } = catalog({});
  let reads = 0;
  const result = await searchGear(
    weapons({ weaponType: 'wands', quality: ['epic'] }),
    async () => {
      reads++;
      throw new Error('Unexpected game read');
    },
    readEverloot,
  );
  expect(reads).toBe(0);
  expect(result).toMatchObject({ data: { items: [] }, catalog: { listed: 0, incomplete: false } });
});

test('catalog failures surface as tool errors', async () => {
  const failing = async () => {
    throw Error('Everloot unavailable');
  };
  await expect(
    searchGear(
      weapons({ weaponType: 'staves' }),
      async () => {
        throw new Error('Unexpected game read');
      },
      failing,
    ),
  ).rejects.toThrow('Everloot item catalog could not list this category');
});
