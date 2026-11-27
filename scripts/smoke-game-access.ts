import assert from 'node:assert/strict';
import { Effect, Schema } from 'effect';
import * as Game from '@wisp/agent/game-access';
import { gameReading, inspectionResults, unavailableGameAccess } from '@wisp/agent/game-access';
import type { addonSmokeFixtures } from './addon-smoke-fixtures.ts';

interface Options {
  addonFixtures?: ReturnType<typeof addonSmokeFixtures>;
  researchMode?: boolean;
  simulationSnapshot?: unknown;
}

export function smokeGameAccess({ addonFixtures, researchMode, simulationSnapshot }: Options) {
  const reads: string[] = [];
  const readFixture = <A>(kind: string, schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.tap(() => Effect.sync(() => reads.push(kind))),
    );
  const inspections = addonFixtures?.inspections;
  const gameAccess = Game.Service.of({
    ...unavailableGameAccess,
    ...(simulationSnapshot === undefined
      ? {}
      : {
          readCharacter: () => readFixture('character', gameReading, simulationSnapshot),
        }),
    ...(researchMode
      ? {
          readTraining: () =>
            readFixture('training', inspectionResults.training, {
              status: 'available',
              source: 'Synthetic catalog-miss fixture',
              data: {
                class: 'MAGE',
                spells: [],
                total: 0,
                unresolvedNames: 0,
                version: 'forever',
                note: 'Synthetic empty catalog result for this regression. Missing coverage is not proof of absence; investigate acquisition and availability with external sources.',
              },
            }),
        }
      : {}),
    ...(inspections
      ? {
          readQuestieQuest: Effect.fn('SmokeGameAccess.readQuestieQuest')(function* (_, args) {
            assert.equal(args.questId, 600001);
            return yield* readFixture(
              'questie_quest',
              inspectionResults.questie_quest,
              inspections.questie_quest,
            );
          }),
          readQuestieChain: Effect.fn('SmokeGameAccess.readQuestieChain')(function* (_, args) {
            assert.equal(args.questId, 600001);
            return yield* readFixture(
              'questie_chain',
              inspectionResults.questie_chain,
              inspections.questie_chain,
            );
          }),
          findObjectLocations: Effect.fn('SmokeGameAccess.findObjectLocations')(
            function* (_, args) {
              assert.equal(args.objectId, 99);
              assert.equal(args.mapId, 1454);
              return yield* readFixture(
                'object_locations',
                inspectionResults.object_locations,
                inspections.object_locations,
              );
            },
          ),
          findStoredItem: Effect.fn('SmokeGameAccess.findStoredItem')(function* (_, args) {
            assert.equal(args.itemId, 123);
            return yield* readFixture(
              'stored_item',
              inspectionResults.stored_item,
              inspections.stored_item,
            );
          }),
          readItemPrices: Effect.fn('SmokeGameAccess.readItemPrices')(function* (_, args) {
            assert.deepEqual(args.itemIds, [123, 999]);
            return yield* readFixture(
              'item_prices',
              inspectionResults.item_prices,
              inspections.item_prices,
            );
          }),
        }
      : {}),
  });
  return { gameAccess, reads };
}
