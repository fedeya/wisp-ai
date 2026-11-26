import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { addonSmokeFixtures } from '../addon-smoke-fixtures.ts';
import { smokeGameAccess } from '../smoke-game-access.ts';

test('synthetic addon diagnostics load the real adapters and their shared dependencies offline', () => {
  const result = addonSmokeFixtures(fileURLToPath(new URL('../../', import.meta.url)));
  expect(result.report).toMatchObject({
    questie: { quests: true, objects: true },
    syndicator: { status: 'ready' },
    auctionator: { status: 'ready' },
    polestar: { status: 'missing', guides: false },
  });
  expect(Object.keys(result.inspections).sort()).toEqual([
    'item_prices',
    'object_locations',
    'questie_chain',
    'questie_quest',
    'stored_item',
  ]);
  for (const inspection of Object.values(result.inspections)) {
    expect(inspection.status).toBe('available');
    expect(inspection.data).toBeDefined();
  }
  expect(result.inspections.stored_item.data).toMatchObject({ totalCached: 10 });
  expect(result.inspections.item_prices.data).toMatchObject({
    prices: [
      { itemId: 123, status: 'available', unitPriceCopper: 450, ageDays: 3, ageKnown: true },
      { itemId: 999, status: 'unknown', ageKnown: false },
    ],
  });
});

test('the smoke GameAccess serves the Lua fixtures through the named inspection methods', async () => {
  const addonFixtures = addonSmokeFixtures(fileURLToPath(new URL('../../', import.meta.url)));
  const { gameAccess, reads } = smokeGameAccess({ addonFixtures });
  const replies = await Effect.runPromise(
    Effect.all([
      gameAccess.readQuestieQuest('smoke', { questId: 600001 }),
      gameAccess.readQuestieChain('smoke', { questId: 600001 }),
      gameAccess.findObjectLocations('smoke', { objectId: 99, mapId: 1454 }),
      gameAccess.findStoredItem('smoke', { itemId: 123 }),
      gameAccess.readItemPrices('smoke', { itemIds: [123, 999] }),
    ]),
  );
  expect(replies.map((reply) => reply.status)).toEqual(Array(5).fill('available'));
  expect(reads).toEqual(Object.keys(addonFixtures.inspections));
});

test('research and simulation can read their fixtures without HTTP', async () => {
  const simulationSnapshot = {
    sections: { spells: { status: 'available', data: { spells: [{ id: 205 }] } } },
  };
  const { gameAccess, reads } = smokeGameAccess({ researchMode: true, simulationSnapshot });
  await expect(
    Effect.runPromise(gameAccess.readTraining('smoke', { class: 'MAGE' })),
  ).resolves.toMatchObject({ status: 'available', data: { spells: [], total: 0 } });
  await expect(Effect.runPromise(gameAccess.readCharacter('smoke', ['spells']))).resolves.toEqual(
    simulationSnapshot,
  );
  await expect(Effect.runPromise(gameAccess.readTarget('smoke', {}))).rejects.toThrow(
    'No active connection',
  );
  expect(reads).toEqual(['training', 'character']);
});
