import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Exit, Schema } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as Capabilities from '@wisp/agent/capabilities';
import { CapabilitySettings } from '@wisp/server/capabilities';
import { IntegrationState } from '../apps/server/src/integrations/integration-state.ts';
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

test('actual tool definitions follow per-API readiness, parent switches and expiration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-addon-tools-'));
  const previous = process.env.WOW_CAPABILITIES_FILE;
  try {
    const settings = new CapabilitySettings(path.join(directory, 'choices.json'));
    settings.agentFile = path.join(directory, 'agent.json');
    process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
    const state = new IntegrationState(settings);
    const readCapabilities = Effect.flatMap(Capabilities.Service, (settings) => settings.read).pipe(
      Effect.provide(Capabilities.layerFromFile()),
      Effect.provide(NodeFileSystem.layer),
    );
    // A tool as the agent offers it this turn, or null while its capability is off.
    const resolve = async <T extends { capability?: string }>(definition: T) =>
      toolOffered(definition, await Effect.runPromise(readCapabilities)) ? definition : null;
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
    await settings.publish();
    assert.equal(await resolve(hearthstone), null);
    assert.equal(await resolve(combat), null);
    for (const definition of [quest, chain, object, stored, prices, guideStep, createGuide]) {
      assert.equal(await resolve(definition), null);
    }
    assert.equal(await resolve(flightPaths), null);
    assert.ok(state.receive(report));
    await settings.publish();
    assert.ok(await resolve(hearthstone));
    assert.ok(await resolve(combat));
    for (const definition of [quest, chain, stored, prices, guideStep, createGuide]) {
      assert.ok(await resolve(definition));
    }
    assert.ok(await resolve(flightPaths));
    assert.equal(
      await resolve(object),
      null,
      'Questie NPC/quest readiness does not invent object readiness',
    );
    const context = integrationContext(settings.snapshot());
    assert.ok(
      context
        .find((entry) => entry.id === 'integration:questie')
        ?.unavailableTools.includes('questie__find_object_locations'),
    );
    await settings.set('tool:get_quest', false);
    assert.equal(await resolve(quest), null);
    assert.ok(await resolve(chain));
    await settings.set('integration:syndicator', false);
    assert.equal(await resolve(stored), null);
    await settings.set('integration:syndicator', true);
    assert.ok(await resolve(stored));
    state.receive({
      ...report,
      syndicator: { status: 'waiting' },
      auctionator: { status: 'missing' },
      polestar: { status: 'partial', guides: false },
    });
    await settings.publish();
    assert.equal(await resolve(stored), null);
    assert.equal(await resolve(prices), null);
    assert.ok(await resolve(guideStep), 'Reading the step does not need the guide API');
    assert.equal(await resolve(createGuide), null);
    state.reset();
    await settings.publish();
    assert.equal(await resolve(hearthstone), null);
    assert.equal(await resolve(chain), null);
    assert.equal(await resolve(flightPaths), null);
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_CAPABILITIES_FILE;
    } else {
      process.env.WOW_CAPABILITIES_FILE = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
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
