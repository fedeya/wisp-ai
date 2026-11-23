import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { IntegrationState } from '../apps/bridge/src/integrations/integration-state.ts';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import flightPaths from '../apps/agent/agent/tools/wow__inspect_flight_paths.ts';
import quest from '../apps/agent/agent/tools/questie__get_quest.ts';
import chain from '../apps/agent/agent/tools/questie__get_quest_chain.ts';
import object from '../apps/agent/agent/tools/questie__find_object_locations.ts';
import stored from '../apps/agent/agent/tools/syndicator__find_item.ts';
import prices from '../apps/agent/agent/tools/auctionator__get_item_prices.ts';
import guideStep from '../apps/agent/agent/tools/polestar__get_guide_step.ts';
import createGuide from '../apps/agent/agent/tools/polestar__create_guide.ts';
import hearthstone from '../apps/agent/agent/tools/wow__inspect_hearthstone.ts';
import combat from '../apps/agent/agent/tools/wow__read_combat.ts';
import {
  questChainInput,
  storedItemInput,
  itemPricesInput,
  objectLocationsInput,
  polestarGuideInput,
  inspectionSchema,
} from '@wisp/protocol/game-inspection';
import { integrationContext } from '@wisp/protocol/capabilities';

test('item and spell references can opt into cooldown readings', () => {
  const args = { kind: 'item', id: 3827 };
  assert.deepEqual(inspectionSchema.parse({ kind: 'reference', args }), {
    kind: 'reference',
    args,
  });
  for (const kind of ['item', 'spell']) {
    const request = { kind: 'reference', args: { ...args, kind, includeCooldown: true } };
    assert.deepEqual(inspectionSchema.parse(request), request);
  }
  for (const kind of ['quest', 'talent']) {
    const request = { kind: 'reference', args: { ...args, kind, includeCooldown: true } };
    assert.equal(inspectionSchema.safeParse(request).success, false);
  }
});

test('actual new Eve definitions follow per-API readiness, parent switches and expiration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-addon-tools-'));
  const previous = process.env.WOW_CAPABILITIES_FILE;
  try {
    const settings = new CapabilitySettings(path.join(directory, 'choices.json'));
    settings.agentFile = path.join(directory, 'agent.json');
    process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
    const state = new IntegrationState(settings);
    const resolve = async (definition: unknown) =>
      dynamicEvaluate(definition as never)({} as never);
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
  assert.equal(questChainInput.safeParse({ questId: 1, limit: 1000 }).success, false);
  assert.equal(questChainInput.safeParse({ questId: 1, version: 'classic' }).success, false);
  assert.equal(storedItemInput.safeParse({ itemId: 1, includeGuild: false }).success, true);
  assert.equal(storedItemInput.safeParse({ itemId: 1, script: 'x' }).success, false);
  assert.equal(itemPricesInput.safeParse({ itemIds: Array(21).fill(1) }).success, false);
  assert.equal(objectLocationsInput.safeParse({}).success, false);
  assert.deepEqual(polestarGuideInput.parse({}), { upcoming: 2 });
  assert.equal(polestarGuideInput.safeParse({ upcoming: 6 }).success, false);
  assert.equal(polestarGuideInput.safeParse({ guideId: 'x' }).success, false);
  assert.equal(objectLocationsInput.safeParse({ objectId: 99, mapId: 1454 }).success, true);
  assert.equal(inspectionSchema.safeParse({ kind: 'hearthstone', args: {} }).success, true);
  assert.equal(
    inspectionSchema.safeParse({ kind: 'hearthstone', args: { itemId: 1 } }).success,
    false,
  );
});

test('flight path inspection trims destination names and bounds the result limit', () => {
  assert.deepEqual(
    inspectionSchema.parse({ kind: 'flight_paths', args: { destination: ' Lakeshire ' } }),
    { kind: 'flight_paths', args: { destination: 'Lakeshire', limit: 20 } },
  );
  assert.equal(
    inspectionSchema.safeParse({ kind: 'flight_paths', args: { limit: 41 } }).success,
    false,
  );
});
