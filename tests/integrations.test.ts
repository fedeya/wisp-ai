import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layer } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { integrationContext, defaultCapabilities } from '@wisp/protocol/capabilities';
import { enabledTool, toolOffered } from '@wisp/agent/enabled-tool';
import { z } from 'zod';
import { agentReads, capabilitiesIn, capabilityFiles, platform } from './capability-fixture.ts';

/** The player's choices as the bridge saves them. */
const SavedSwitches = Schema.fromJsonString(
  Schema.Struct({ enabled: Schema.Record(Schema.String, Schema.Boolean) }),
);

/** Saves `switches` as the player's choices before the bridge reads them. */
const saveSwitches = (file: string, switches: Record<string, boolean>) =>
  FileSystem.FileSystem.use((fs) =>
    fs.writeFileString(file, JSON.stringify({ enabled: switches })),
  );

layer(platform)('integrations', (it) => {
  it.effect(
    'integration availability and master switches govern real tool definitions and backend admission, preserving preferences',
    () =>
      Effect.gen(function* () {
        const files = yield* capabilityFiles;
        const { settings, integrations: state } = yield* capabilitiesIn(files);
        yield* TestClock.setTime(1000);
        const definition = enabledTool('find_npc_locations', {
          description: 'Questie lookup',
          inputSchema: z.object({}),
          execute: () => null,
        });
        const resolve = Effect.map(agentReads(files.agentFile), (capabilities) =>
          toolOffered(definition, capabilities) ? definition : null,
        );
        yield* settings.publish;
        assert.equal(yield* resolve, null, 'unreported addons are not offered');
        assert.equal(
          yield* state.receive({
            version: '0.2',
            questie: {
              status: 'partial',
              npcs: true,
              trainers: false,
              services: false,
              version: '4',
            },
          }),
          true,
        );
        yield* settings.publish;
        assert.equal(yield* resolve, definition);
        assert.equal(yield* settings.enabled('tool:find_npc_locations'), true);
        assert.equal(
          (yield* settings.snapshot).find((entry) => entry.id === 'integration:questie')?.status,
          'partial',
        );
        yield* settings.set('integration:questie', false);
        assert.equal(yield* resolve, null);
        assert.equal(
          yield* settings.enabled('tool:find_npc_locations'),
          false,
          'RPC uses the same parent gate',
        );
        assert.equal(
          (yield* settings.snapshot).find((entry) => entry.id === 'tool:find_npc_locations')
            ?.enabled,
          true,
        );
        yield* settings.set('tool:find_npc_locations', false);
        yield* settings.set('integration:questie', true);
        assert.equal(yield* resolve, null, 'master does not overwrite the child');
        yield* settings.set('tool:find_npc_locations', true);
        assert.equal(
          yield* state.receive({
            version: '0.2',
            questie: { status: 'incompatible', trainers: false, services: false },
          }),
          true,
        );
        yield* settings.publish;
        assert.equal(yield* resolve, null);
        assert.equal(yield* state.receive({ arbitrary: true }), false);
        yield* state.receive({
          version: '0.2',
          questie: { status: 'ready', npcs: true, trainers: true, services: true },
        });
        yield* TestClock.adjust(180_001);
        yield* state.refresh;
        yield* settings.publish;
        assert.equal(
          yield* settings.enabled('tool:query_character'),
          false,
          'stale game reports expire',
        );
        assert.equal(yield* resolve, null);
        const persisted = yield* FileSystem.FileSystem.use((fs) =>
          fs.readFileString(files.file),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SavedSwitches)));
        assert.equal(
          persisted.enabled['tool:find_npc_locations'],
          true,
          'availability is not saved as a preference',
        );
        yield* state.reset;
        assert.equal(
          (yield* settings.snapshot).find((entry) => entry.id === 'integration:questie')?.status,
          'waiting',
        );
        assert.equal(yield* settings.enabled('unknown:tool'), false);
        assert.throws(() => enabledTool('unregistered', definition), /Unregistered/);
      }),
  );

  it.effect(
    'integration context records disabled choices without leaking descriptions or external instructions',
    () =>
      Effect.gen(function* () {
        const files = yield* capabilityFiles;
        yield* saveSwitches(files.file, {
          'integration:questie': false,
          'tool:search_database': false,
        });
        const { settings } = yield* capabilitiesIn(files);
        const context = integrationContext(yield* settings.snapshot);
        assert.equal(context.find((entry) => entry.id === 'integration:questie')?.enabled, false);
        assert.ok(
          context
            .find((entry) => entry.id === 'integration:thewowdb')
            ?.disabledTools.includes('thewowdb__search_database'),
        );
        assert.equal(JSON.stringify(context).includes('description'), false);
      }),
  );

  it.effect(
    'built-in capabilities ignore legacy switches while WoW availability and optional memory remain independent',
    () =>
      Effect.gen(function* () {
        const files = yield* capabilityFiles;
        yield* saveSwitches(files.file, {
          'integration:wow': false,
          'integration:wisp': false,
          'tool:query_character': false,
          'tool:set_conversation_title': false,
          'core:wow': false,
          'memory:preferences': false,
        });
        const { settings, integrations: state } = yield* capabilitiesIn(files);
        assert.equal(
          yield* settings.enabled('tool:query_character'),
          false,
          'game connection is required',
        );
        assert.equal(yield* settings.enabled('tool:set_conversation_title'), true);
        assert.equal(yield* settings.enabled('tool:manage_panel'), true);
        yield* state.receive({
          version: '0.2',
          questie: { status: 'missing', trainers: false, services: false },
        });
        assert.equal(yield* settings.enabled('tool:query_character'), true);
        assert.equal(yield* settings.enabled('memory:preferences'), false);
        assert.equal(yield* settings.enabled('memory:character'), true);
        const context = integrationContext(yield* settings.snapshot);
        assert.ok(
          context.every(
            (entry) =>
              !['core:wow', 'core:wisp', 'memory:preferences', 'memory:character'].includes(
                entry.id,
              ),
          ),
        );
        for (const id of ['core:wow', 'tool:set_conversation_title']) {
          assert.equal((yield* Effect.flip(settings.set(id, false)))._tag, 'UnknownCapability');
        }
        yield* state.reset;
        assert.equal(yield* settings.enabled('tool:query_character'), false);
        assert.equal(yield* settings.enabled('tool:set_conversation_title'), true);
      }),
  );
});

test('every local tool belongs to core or one optional integration and exposes a unique namespaced identity', () => {
  const catalog = defaultCapabilities();
  const tools = catalog.filter((entry) => entry.id.startsWith('tool:'));
  assert.equal(new Set(tools.map((entry) => entry.toolName)).size, tools.length);
  for (const tool of tools) {
    if (tool.id === 'tool:web_fetch') {
      assert.equal(tool.toolName, 'web_fetch');
    } else {
      assert.match(tool.toolName!, /^[a-z]+__[a-z_]+$/);
    }
    assert.ok(catalog.some((entry) => entry.id === tool.parent && !entry.parent));
  }
});
