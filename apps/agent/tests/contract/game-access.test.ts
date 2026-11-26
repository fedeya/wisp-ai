import { Effect } from 'effect';
import { expect, expectTypeOf, test } from 'vitest';
import { inspectWith, type ItemSourcesResult } from '../../src/host/game-access.ts';

const request = { kind: 'item_sources' as const, args: { itemIds: [14149] } };

test('item source inspections return a typed and validated item list', async () => {
  const result = {
    status: 'available',
    items: [{ itemId: 14149, sourceKnown: false, sourcesStatus: 'unavailable' }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const inspect = inspectWith(() => Effect.succeed(result));
  const reading = inspect('turn', request);
  expectTypeOf(reading).toEqualTypeOf<Effect.Effect<ItemSourcesResult, Error>>();
  expect((await Effect.runPromise(reading)).items).toEqual(result.items);
});

test('item source inspections reject an object with malformed items', async () => {
  const inspect = inspectWith(() =>
    Effect.succeed({
      status: 'available',
      items: [{ itemId: '14149', sourceKnown: false, sourcesStatus: 'unavailable' }],
      priceStatus: 'unavailable',
      note: 'No known sources',
    }),
  );
  await expect(Effect.runPromise(inspect('turn', request))).rejects.toThrow('number');
});
