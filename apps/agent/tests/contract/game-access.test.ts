import { Effect, Schema } from 'effect';
import { expect, expectTypeOf, test } from 'vitest';
import {
  itemSourcesResult,
  unavailableGameAccess,
  type ItemSourcesResult,
  type InspectionResult,
} from '../../src/host/game-access.ts';
import * as Game from '../../src/host/game-access.ts';

const input = { itemIds: [14149] };
const decode = Schema.decodeUnknownEffect(itemSourcesResult);

test('item source inspections return a typed and validated item list', async () => {
  const result: ItemSourcesResult = {
    status: 'available',
    items: [{ itemId: 14149, sourceKnown: false, sourcesStatus: 'unavailable' }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const game = Game.Service.of({
    ...unavailableGameAccess,
    itemSources: () => Effect.succeed(result).pipe(Effect.tap(decode)),
  });
  const reading = game.itemSources('turn', input);
  expectTypeOf(reading).toEqualTypeOf<Effect.Effect<ItemSourcesResult, Error>>();
  expect((await Effect.runPromise(reading)).items).toEqual(result.items);
});

test('inspection methods declare distinct caller and implementation contracts', () => {
  const target = unavailableGameAccess.readTarget('turn', {});
  expectTypeOf(target).toEqualTypeOf<Effect.Effect<InspectionResult<'target'>, Error>>();
  const gear = unavailableGameAccess.readGearCandidates('turn', { itemIds: [14149] });
  expectTypeOf(gear).toEqualTypeOf<Effect.Effect<InspectionResult<'gear_candidates'>, Error>>();
  expectTypeOf<
    Extract<
      InspectionResult<'gear_candidates'>,
      { status: 'available' }
    >['data']['items'][number]['id']
  >().toEqualTypeOf<number>();

  const readTarget: Game.Service['Service']['readTarget'] = () =>
    Effect.succeed({ status: 'available', data: { note: 'Target' } });
  const game = Game.Service.of({
    ...unavailableGameAccess,
    // @ts-expect-error A target result cannot implement the gear candidate operation.
    readGearCandidates: readTarget,
  });
  expect(game.readGearCandidates).toBe(readTarget);
});

test('item source inspections reject an object with malformed items', async () => {
  const malformed = {
    status: 'available' as const,
    items: [{ itemId: '14149', sourceKnown: false, sourcesStatus: 'unavailable' as const }],
    priceStatus: 'unavailable',
    note: 'No known sources',
  };
  const game = Game.Service.of({
    ...unavailableGameAccess,
    // @ts-expect-error Runtime validation must not hide a wrong producer type.
    itemSources: () => Effect.succeed(malformed).pipe(Effect.tap(decode)),
  });
  await expect(Effect.runPromise(game.itemSources('turn', input))).rejects.toThrow('number');
});
