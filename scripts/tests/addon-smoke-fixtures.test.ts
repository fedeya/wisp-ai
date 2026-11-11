import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { addonSmokeFixtures } from '../addon-smoke-fixtures.ts';

test('synthetic addon diagnostics load the real adapters and their shared dependencies offline', () => {
  const result = addonSmokeFixtures(fileURLToPath(new URL('../../', import.meta.url)));
  expect(result.report).toMatchObject({
    questie: { quests: true, objects: true },
    syndicator: { status: 'ready' },
    auctionator: { status: 'ready' },
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
