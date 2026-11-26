import { Effect, Schema } from 'effect';
import { expect, expectTypeOf, test } from 'vitest';
import {
  GameAccess,
  itemSourcesResult,
  unavailableGameAccess,
  type ItemSourcesResult,
} from '../../src/host/game-access.ts';

const input = { itemIds: [14149] };
const decode = Schema.decodeUnknownEffect(itemSourcesResult);

test('item source inspections return a typed and validated item list', async () => {
  const result: ItemSourcesResult = {
    status: 'available',
    items: [{ itemId: 14149, sourceKnown: false, sourcesStatus: 'unavailable' }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const game = GameAccess.of({
    ...unavailableGameAccess,
    itemSources: () => Effect.succeed(result).pipe(Effect.tap(decode)),
  });
  const reading = game.itemSources('turn', input);
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
  const game = GameAccess.of({
    ...unavailableGameAccess,
    // @ts-expect-error Runtime validation must not hide a wrong producer type.
    itemSources: () => Effect.succeed(malformed).pipe(Effect.tap(decode)),
  });
  await expect(Effect.runPromise(game.itemSources('turn', input))).rejects.toThrow('number');
});
