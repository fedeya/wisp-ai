import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layer } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { toolOffered } from '@wisp/agent/enabled-tool';
import flightPaths from '../apps/agent/src/wisp/tools/wow__inspect_flight_paths.ts';
import quest from '../apps/agent/src/wisp/tools/questie__get_quest.ts';
import chain from '../apps/agent/src/wisp/tools/questie__get_quest_chain.ts';
import object from '../apps/agent/src/wisp/tools/questie__find_object_locations.ts';
import stored from '../apps/agent/src/wisp/tools/syndicator__find_item.ts';
import prices from '../apps/agent/src/wisp/tools/auctionator__get_item_prices.ts';
import guideStep from '../apps/agent/src/wisp/tools/polestar__get_guide_step.ts';
import createGuide from '../apps/agent/src/wisp/tools/polestar__create_guide.ts';
import hearthstone from '../apps/agent/src/wisp/tools/wow__inspect_hearthstone.ts';
import combat from '../apps/agent/src/wisp/tools/wow__read_combat.ts';
import {
  questChainInput,
  storedItemInput,
  itemPricesInput,
  objectLocationsInput,
  polestarGuideInput,
  inspectionParseOptions,
  inspectionSchema,
} from '@wisp/agent/contract/game-inspection';
import type { GameInspection } from '@wisp/agent/game-access';
import { integrationContext } from '@wisp/protocol/capabilities';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { agentReads, capabilitiesIn, capabilityFiles, platform } from './capability-fixture.ts';

// Inputs decode as their tools decode them; strict ones reject unknown keys.
const accepts = (schema: Schema.Top & Schema.Decoder<unknown>, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(input, rejectUnknownKeys));
// An inspection as the server decodes it.
const inspect = (kind: GameInspection['kind'], args: unknown) =>
  Schema.decodeUnknownExit(inspectionSchema)({ kind, args }, inspectionParseOptions(kind));
const inspected = (kind: GameInspection['kind'], args: unknown) =>
  Exit.match(inspect(kind, args), { onSuccess: (value) => value, onFailure: () => undefined });

test('item and spell references can opt into cooldown readings', () => {
  const args = { kind: 'item', id: 3827 };
  assert.deepEqual(inspected('reference', args), { kind: 'reference', args });
  for (const kind of ['item', 'spell']) {
    const request = { ...args, kind, includeCooldown: true };
    assert.deepEqual(inspected('reference', request), { kind: 'reference', args: request });
  }
  for (const kind of ['quest', 'talent']) {
    const request = { ...args, kind, includeCooldown: true };
    assert.equal(Exit.isSuccess(inspect('reference', request)), false);
  }
});

layer(platform)('addon tools', (it) => {
  it.effect(
    'actual tool definitions follow per-API readiness, parent switches and expiration',
    () =>
      Effect.gen(function* () {
        const files = yield* capabilityFiles;
        const { settings, integrations: state } = yield* capabilitiesIn(files);
        // A tool as the agent offers it this turn, or null while its capability is off.
        const resolve = <T extends { capability?: string }>(definition: T) =>
          Effect.map(agentReads(files.agentFile), (capabilities) =>
            toolOffered(definition, capabilities) ? definition : null,
          );
        const report = {
          version: '1.60',
          questie: {
            status: 'partial',
            npcs: true,
            quests: true,
            objects: false,
            trainers: false,
            services: false,
          },
          syndicator: { status: 'ready' },
          auctionator: { status: 'partial' },
          polestar: { status: 'ready', guides: true },
        };
        yield* settings.publish;
        assert.equal(yield* resolve(hearthstone), null);
        assert.equal(yield* resolve(combat), null);
        for (const definition of [quest, chain, object, stored, prices, guideStep, createGuide]) {
          assert.equal(yield* resolve(definition), null);
        }
        assert.equal(yield* resolve(flightPaths), null);
        assert.ok(yield* state.receive(report));
        yield* settings.publish;
        assert.ok(yield* resolve(hearthstone));
        assert.ok(yield* resolve(combat));
        for (const definition of [quest, chain, stored, prices, guideStep, createGuide]) {
          assert.ok(yield* resolve(definition));
        }
        assert.ok(yield* resolve(flightPaths));
        assert.equal(
          yield* resolve(object),
          null,
          'Questie NPC/quest readiness does not invent object readiness',
        );
        const context = integrationContext(yield* settings.snapshot);
        assert.ok(
          context
            .find((entry) => entry.id === 'integration:questie')
            ?.unavailableTools.includes('questie__find_object_locations'),
        );
        yield* settings.set('tool:get_quest', false);
        assert.equal(yield* resolve(quest), null);
        assert.ok(yield* resolve(chain));
        yield* settings.set('integration:syndicator', false);
        assert.equal(yield* resolve(stored), null);
        yield* settings.set('integration:syndicator', true);
        assert.ok(yield* resolve(stored));
        yield* state.receive({
          ...report,
          syndicator: { status: 'waiting' },
          auctionator: { status: 'missing' },
          polestar: { status: 'partial', guides: false },
        });
        yield* settings.publish;
        assert.equal(yield* resolve(stored), null);
        assert.equal(yield* resolve(prices), null);
        assert.ok(yield* resolve(guideStep), 'Reading the step does not need the guide API');
        assert.equal(yield* resolve(createGuide), null);
        yield* state.reset;
        yield* settings.publish;
        assert.equal(yield* resolve(hearthstone), null);
        assert.equal(yield* resolve(chain), null);
        assert.equal(yield* resolve(flightPaths), null);
      }),
  );
});
test('new inspection inputs bound work and reject executable or cross-version arguments', () => {
  assert.equal(accepts(questChainInput, { questId: 1, limit: 1000 }), false);
  assert.equal(accepts(questChainInput, { questId: 1, version: 'classic' }), false);
  assert.equal(accepts(storedItemInput, { itemId: 1, includeGuild: false }), true);
  assert.equal(accepts(storedItemInput, { itemId: 1, script: 'x' }), false);
  assert.equal(accepts(itemPricesInput, { itemIds: Array(21).fill(1) }), false);
  assert.equal(accepts(objectLocationsInput, {}), false);
  assert.deepEqual(Schema.decodeUnknownSync(polestarGuideInput)({}), { upcoming: 2 });
  assert.equal(accepts(polestarGuideInput, { upcoming: 6 }), false);
  assert.equal(accepts(polestarGuideInput, { guideId: 'x' }), false);
  assert.equal(accepts(objectLocationsInput, { objectId: 99, mapId: 1454 }), true);
  assert.equal(Exit.isSuccess(inspect('hearthstone', {})), true);
  assert.equal(Exit.isSuccess(inspect('hearthstone', { itemId: 1 })), false);
});

test('flight path inspection trims destination names and bounds the result limit', () => {
  assert.deepEqual(inspected('flight_paths', { destination: ' Lakeshire ' }), {
    kind: 'flight_paths',
    args: { destination: 'Lakeshire', limit: 20 },
  });
  assert.equal(Exit.isSuccess(inspect('flight_paths', { limit: 41 })), false);
});
