import { expect, test } from 'vitest';
import { armorSearchInput, weaponSearchInput } from '@wisp/protocol/game-inspection';
import { gearCategory, searchGear, type GearSearch } from '../src/integrations/gear-search.ts';

const armor = (args: unknown): GearSearch => ({
  kind: 'search_armor',
  args: armorSearchInput.parse(args),
});
const weapons = (args: unknown): GearSearch => ({
  kind: 'search_weapons',
  args: weaponSearchInput.parse(args),
});

function catalog(pages: Record<string, { ids: number[]; total?: number }>, sse = false) {
  const calls: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const args = body.params.arguments;
    calls.push(args);
    const page = pages[args.quality] ?? { ids: [] };
    const json = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'listing' }],
        structuredContent: {
          label: 'found in game files, unconfirmed',
          build: '1.60.1.70959',
          items: page.ids.map((itemId) => ({ itemId })),
          total: page.total ?? page.ids.length,
        },
      },
    });
    return new Response(sse ? 'event: message\ndata: ' + json + '\n\n' : json);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
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
  expect(armorSearchInput.safeParse({ slot: 'chest' }).success).toBe(false);
});

test('a search lists every requested quality and reads the merged IDs from the game once', async () => {
  const { fetcher, calls } = catalog({
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
    { fetch: fetcher },
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

test('empty listings skip the game read, and event-stream replies are accepted', async () => {
  const { fetcher } = catalog({}, true);
  let reads = 0;
  const result = await searchGear(
    weapons({ weaponType: 'wands', quality: ['epic'] }),
    async () => {
      reads++;
      return {};
    },
    { fetch: fetcher },
  );
  expect(reads).toBe(0);
  expect(result).toMatchObject({ data: { items: [] }, catalog: { listed: 0, incomplete: false } });
});

test('catalog failures surface as tool errors', async () => {
  const failing = (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true } }))) as never;
  await expect(
    searchGear(weapons({ weaponType: 'staves' }), async () => ({}), { fetch: failing }),
  ).rejects.toThrow('Everloot item catalog could not list this category');
});
