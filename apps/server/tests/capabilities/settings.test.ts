import { assert, describe, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, FileSystem, Layer, Path, Ref, Schema } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import type { Capability } from '@wisp/protocol/capabilities';
import * as Capabilities from '#/capabilities';
import type { FeatureValues } from '#/features';
import { featuresAt } from './fixture.ts';

/** Makes the next writes of the file system below fail, as a full disk would. */
class FailWrites extends Context.Service<FailWrites, Ref.Ref<boolean>>()(
  '@wisp/server/tests/capabilities/FailWrites',
) {}

/** The Node file system, with writes that fail while `FailWrites` is on. */
const fileSystem = Layer.effectContext(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failing = yield* Ref.make(false);
    const service = FileSystem.FileSystem.of({
      ...fs,
      writeFileString: (path, data, options) =>
        Effect.gen(function* () {
          if (yield* Ref.get(failing)) {
            return yield* PlatformError.systemError({
              _tag: 'Unknown',
              module: 'FileSystem',
              method: 'writeFile',
              pathOrDescriptor: path,
              cause: new Error('ENOSPC: no space left on device'),
            });
          }
          return yield* fs.writeFileString(path, data, options);
        }),
    });
    return Context.make(FileSystem.FileSystem, service).pipe(Context.add(FailWrites, failing));
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

/** Fails the writes until the test ends, or until `allow` runs. */
const failWrites = Effect.gen(function* () {
  const failing = yield* FailWrites;
  yield* Effect.acquireRelease(Ref.set(failing, true), () => Ref.set(failing, false));
  return { allow: Ref.set(failing, false) };
});

const catalog: readonly Capability[] = [
  { id: 'core:wow', name: 'WoW', group: 'core', kind: 'game', description: '' },
  {
    id: 'tool:query_character',
    name: 'Character',
    group: 'core',
    parent: 'core:wow',
    description: '',
  },
  { id: 'integration:questie', name: 'Questie', group: 'integrations', description: '' },
  {
    id: 'tool:get_quest',
    name: 'Quest',
    group: 'integrations',
    parent: 'integration:questie',
    description: '',
  },
  { id: 'tool:coach', name: 'Coach', group: 'integrations', description: '' },
  { id: 'mcp:notes', name: 'Notes', group: 'integrations', kind: 'mcp', description: '' },
];

/** The files of one test, in a folder removed when it ends. */
const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-capabilities-' });
  return {
    file: path.join(directory, 'capabilities.json'),
    agentFile: path.join(directory, 'agent-capabilities.json'),
  };
});

type Files = Effect.Success<typeof files>;

/** Capability settings on `at`, read now, with the feature flags `flags` holds. */
const settingsAt = (at: Files, flags: Ref.Ref<FeatureValues>) =>
  Capabilities.CapabilitySettings.useSync((settings) => settings).pipe(
    Effect.provide(
      Capabilities.settingsLayerWith({ ...at, catalog, toolFlags: { coach: 'combat_coach' } }).pipe(
        Layer.provide(featuresAt(Ref.get(flags))),
      ),
    ),
  );

/** Feature flags a test changes as it goes. */
const flagsOf = (values: FeatureValues) => Ref.make(values);

const readJson = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
  );

const ids = (views: readonly { readonly id: string }[]) => views.map((view) => view.id);

layer(Layer.mergeAll(fileSystem, NodePath.layer, NodeCrypto.layerSecureRandom))(
  'CapabilitySettings',
  (it) => {
    describe('switches', () => {
      it.effect('start from the catalog defaults and keep core capabilities on', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          assert.isTrue(yield* settings.configured('tool:query_character'));
          assert.isTrue(yield* settings.enabled('tool:get_quest'));
          assert.isFalse(yield* settings.enabled('unknown:tool'));
          const notes = (yield* settings.snapshot).find((view) => view.id === 'mcp:notes');
          assert.deepStrictEqual(
            { status: notes?.status, effective: notes?.effective },
            { status: 'configured', effective: true },
          );
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(at.file));
        }),
      );

      it.effect('are saved as they were before and read back after a restart', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const flags = yield* flagsOf({ combat_coach: true });
          const settings = yield* settingsAt(at, flags);
          yield* Effect.all(
            [settings.set('integration:questie', false), settings.set('tool:get_quest', false)],
            { concurrency: 'unbounded' },
          );
          assert.strictEqual(
            yield* FileSystem.FileSystem.use((fs) => fs.readFileString(at.file)),
            JSON.stringify(
              { enabled: { 'integration:questie': false, 'tool:get_quest': false } },
              null,
              2,
            ),
          );
          const restarted = yield* settingsAt(at, flags);
          assert.isFalse(yield* restarted.configured('tool:get_quest'));
          yield* restarted.set('integration:questie', true);
          assert.isFalse(yield* restarted.enabled('tool:get_quest'), 'the child keeps its own');
        }),
      );

      it.effect('turn off the children of a capability that is off', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          yield* settings.set('integration:questie', false);
          assert.isFalse(yield* settings.enabled('tool:get_quest'));
          const quest = (yield* settings.snapshot).find((view) => view.id === 'tool:get_quest');
          assert.deepStrictEqual(
            { enabled: quest?.enabled, effective: quest?.effective },
            { enabled: true, effective: false },
          );
        }),
      );

      it.effect('refuse core, unknown and hidden capabilities', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: false }));
          for (const id of ['tool:query_character', 'unknown:tool', 'tool:coach']) {
            const error = yield* Effect.flip(settings.set(id, false));
            assert.strictEqual(error._tag, 'UnknownCapability');
            assert.strictEqual(error.message, 'Unknown capability or invalid setting');
          }
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(at.file));
        }),
      );

      it.effect('stay as they were when the save fails, with what the disk said', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          yield* failWrites;
          const error = yield* Effect.flip(settings.set('integration:questie', false));
          assert.strictEqual(error._tag, 'CapabilityFileError');
          assert.strictEqual(error.message, 'ENOSPC: no space left on device');
          assert.isTrue(yield* settings.configured('integration:questie'));
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(at.file));
        }),
      );

      it.effect('fail to load from a file that does not decode, and keep it', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const flags = yield* flagsOf({});
          for (const text of [
            '{broken json',
            '[]',
            '{"enabled":[]}',
            '{"enabled":{"tool:get_quest":"off"}}',
          ]) {
            yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(at.file, text));
            const error = yield* Effect.flip(settingsAt(at, flags));
            assert.strictEqual(error._tag, 'CapabilityFileError');
            assert.strictEqual(
              error.message,
              'Invalid capability settings; the file was preserved',
            );
            assert.strictEqual(
              yield* FileSystem.FileSystem.use((fs) => fs.readFileString(at.file)),
              text,
            );
          }
        }),
      );
    });

    describe('availability', () => {
      it.effect('comes from the parent until a capability has its own', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          yield* settings.setAvailability({
            'core:wow': { available: false, status: 'waiting', reason: 'Open WoW.' },
          });
          assert.isFalse(yield* settings.enabled('tool:query_character'));
          const character = (yield* settings.snapshot).find(
            (view) => view.id === 'tool:query_character',
          );
          assert.strictEqual(character?.reason, 'Open WoW.');
          yield* settings.setAvailability({
            'tool:query_character': { available: true, status: 'ready' },
          });
          assert.isFalse(
            yield* settings.enabled('tool:query_character'),
            'its parent is still unavailable',
          );
        }),
      );
    });

    describe('feature flags', () => {
      it.effect('leave a tool behind a flag that is off out everywhere', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const flags = yield* Ref.make<FeatureValues>({ combat_coach: false });
          const settings = yield* settingsAt(at, flags);
          assert.notInclude(ids(yield* settings.snapshot), 'tool:coach');
          assert.isFalse(yield* settings.enabled('tool:coach'));
          yield* settings.publish;
          assert.deepNestedInclude(yield* readJson(at.agentFile), {
            'enabled.tool:coach': false,
          });

          yield* Ref.set(flags, { combat_coach: true });
          assert.include(ids(yield* settings.snapshot), 'tool:coach');
          assert.isTrue(yield* settings.enabled('tool:coach'));
          yield* settings.publish;
          assert.deepNestedInclude(yield* readJson(at.agentFile), {
            'enabled.tool:coach': true,
          });
        }),
      );
    });

    describe('publishing', () => {
      it.effect('writes the effective switches next to the resolved feature flags', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const flags = yield* Ref.make<FeatureValues>({ combat_coach: true, new_panel: true });
          const settings = yield* settingsAt(at, flags);
          yield* settings.set('mcp:notes', false);
          assert.strictEqual(
            yield* FileSystem.FileSystem.use((fs) => fs.readFileString(at.agentFile)),
            JSON.stringify(
              {
                enabled: {
                  'core:wow': true,
                  'tool:query_character': true,
                  'integration:questie': true,
                  'tool:get_quest': true,
                  'tool:coach': true,
                  'mcp:notes': false,
                },
                features: { combat_coach: true, new_panel: true },
              },
              null,
              2,
            ),
          );
          yield* Ref.set(flags, { combat_coach: true, new_panel: false });
          yield* settings.publish;
          assert.deepNestedInclude(yield* readJson(at.agentFile), {
            'features.new_panel': false,
          });
        }),
      );

      it.effect('writes again only when the content changed', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const fs = yield* FileSystem.FileSystem;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          yield* settings.publish;
          // Another writer's content stays until the capabilities change.
          yield* fs.writeFileString(at.agentFile, '{}');
          yield* settings.publish;
          assert.strictEqual(yield* fs.readFileString(at.agentFile), '{}');
          yield* settings.setCatalog(catalog.filter((entry) => entry.id !== 'mcp:notes'));
          yield* settings.publish;
          assert.notDeepNestedInclude(yield* readJson(at.agentFile), {
            'enabled.mcp:notes': true,
          });
        }),
      );

      it.effect('fails with what the disk said and writes on the next publish', () =>
        Effect.gen(function* () {
          const at = yield* files;
          const settings = yield* settingsAt(at, yield* flagsOf({ combat_coach: true }));
          const { allow } = yield* failWrites;
          const error = yield* Effect.flip(settings.publish);
          assert.strictEqual(error.message, 'ENOSPC: no space left on device');
          yield* allow;
          yield* settings.publish;
          assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(at.agentFile));
        }),
      );
    });
  },
);
