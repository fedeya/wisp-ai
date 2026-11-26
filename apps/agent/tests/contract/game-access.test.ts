import { Effect } from 'effect';
import { expect, expectTypeOf, test } from 'vitest';
import { inspectWith, type ItemSourcesResult } from '../../src/host/game-access.ts';

const request = { kind: 'item_sources' as const, args: { itemIds: [14149] } };
const unexpected = () => Effect.fail(new Error('Unexpected raw inspection'));

test('item source inspections return a typed and validated item list', async () => {
  const result: ItemSourcesResult = {
    status: 'available',
    items: [{ itemId: 14149, sourceKnown: false, sourcesStatus: 'unavailable' }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const inspect = inspectWith({ item_sources: () => Effect.succeed(result) }, unexpected);
  const reading = inspect('turn', request);
  expectTypeOf(reading).toEqualTypeOf<Effect.Effect<ItemSourcesResult, Error>>();
  expect((await Effect.runPromise(reading)).items).toEqual(result.items);
});

test('item source inspections reject an object with malformed items', async () => {
  const malformed = {
    status: 'available' as const,
    items: [{ itemId: '14149', sourceKnown: false, sourcesStatus: 'unavailable' as const }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const inspect = inspectWith(
    {
      // @ts-expect-error A typed handler cannot return an item with a string ID.
      item_sources: () => Effect.succeed(malformed),
    },
    unexpected,
  );
  await expect(Effect.runPromise(inspect('turn', request))).rejects.toThrow('number');
});
