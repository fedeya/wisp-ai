import { assert, describe, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, FileSystem, Layer, Path, Ref } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import * as Settings from '../../src/settings/index.ts';

/** Makes the next writes of the file system below fail, as a full disk would. */
class FailWrites extends Context.Service<FailWrites, Ref.Ref<boolean>>()(
  '@wisp/server/tests/settings/FailWrites',
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

/** A data folder for one test, removed when it ends, and its `config.local.json`. */
const configFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-settings-' });
  return path.join(directory, 'config.local.json');
});

/** The settings service on `file`, read now. */
const settingsAt = (file: string) =>
  Settings.Settings.useSync((settings) => settings).pipe(Effect.provide(Settings.layerAt(file)));

const writeConfig = (file: string, text: string) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(file, text));

const readConfig = (file: string) => FileSystem.FileSystem.use((fs) => fs.readFileString(file));

layer(Layer.mergeAll(fileSystem, NodePath.layer, NodeCrypto.layerSecureRandom))(
  'Settings',
  (it) => {
    describe('reading config.local.json', () => {
      it.effect('reads a missing file as no settings and does not create it', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          const settings = yield* settingsAt(file);
          assert.deepStrictEqual(yield* settings.get, {});
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(file));
        }),
      );

      it.effect('reads the saved settings and drops keys it does not know', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          yield* writeConfig(
            file,
            JSON.stringify({
              wow: 'C:/WoW',
              model: 'connection:local:test',
              mcpConfig: 'mcp.json',
              features: { ask_wisp_moments: true },
              old: 1,
            }),
          );
          const settings = yield* settingsAt(file);
          assert.deepStrictEqual(yield* settings.get, {
            wow: 'C:/WoW',
            model: 'connection:local:test',
            mcpConfig: 'mcp.json',
            features: { ask_wisp_moments: true },
          });
        }),
      );

      it.effect('drops the empty model earlier installers saved', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          yield* writeConfig(file, JSON.stringify({ wow: 'C:/WoW', model: '' }));
          const settings = yield* settingsAt(file);
          assert.deepStrictEqual(yield* settings.get, { wow: 'C:/WoW' });
        }),
      );

      it.effect('drops bad feature choices and keeps the rest of the file', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          for (const features of [{ 'Not-A-Flag': true }, { ask_wisp_moments: 'yes' }, []]) {
            yield* writeConfig(file, JSON.stringify({ wow: 'C:/WoW', features }));
            const settings = yield* settingsAt(file);
            assert.deepStrictEqual(yield* settings.get, { wow: 'C:/WoW' });
          }
        }),
      );

      it.effect('fails on a file that does not decode and keeps it', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          for (const text of ['{"wow":', '{"wow":""}', '{"mcpConfig":3}', '[]']) {
            yield* writeConfig(file, text);
            const error = yield* Effect.flip(settingsAt(file));
            assert.strictEqual(error._tag, 'JsonFileError');
            assert.strictEqual(
              error.message,
              'Cannot load config.local.json; the original file was preserved.',
            );
            assert.strictEqual(yield* readConfig(file), text);
          }
        }),
      );
    });

    describe('update', () => {
      it.effect('merges the patch, saves it and returns the settings', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          const settings = yield* settingsAt(file);
          const saved = yield* settings.update({ wow: 'C:/WoW' });
          assert.deepStrictEqual(saved, { wow: 'C:/WoW' });
          yield* settings.update({ features: { ask_wisp_moments: false } });
          assert.deepStrictEqual(yield* settings.get, {
            wow: 'C:/WoW',
            features: { ask_wisp_moments: false },
          });
          // A new reader sees what was saved.
          const reloaded = yield* settingsAt(file);
          assert.deepStrictEqual(yield* reloaded.get, yield* settings.get);
        }),
      );

      it.effect('writes two-space JSON with the keys in the order they were saved', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          yield* writeConfig(file, '{"model":"connection:local:test","model2":"x"}');
          const settings = yield* settingsAt(file);
          yield* settings.update({ wow: 'C:/WoW' });
          yield* settings.update({ model: 'connection:local:other' });
          assert.strictEqual(
            yield* readConfig(file),
            '{\n  "model": "connection:local:other",\n  "wow": "C:/WoW"\n}',
          );
        }),
      );

      it.effect('writes over the empty model and unknown keys of an old file', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          yield* writeConfig(file, '{"model":"","wow":"C:/WoW","old":true}');
          const settings = yield* settingsAt(file);
          yield* settings.update({ features: {} });
          assert.strictEqual(yield* readConfig(file), '{\n  "wow": "C:/WoW",\n  "features": {}\n}');
        }),
      );

      it.effect('leaves out a key the patch sets to undefined', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          const settings = yield* settingsAt(file);
          yield* settings.update({ wow: 'C:/WoW', model: 'connection:local:test' });
          yield* settings.update({ model: undefined });
          assert.strictEqual(yield* readConfig(file), '{\n  "wow": "C:/WoW"\n}');
        }),
      );

      it.effect('runs writes one at a time, in call order', () =>
        Effect.gen(function* () {
          const file = yield* configFile;
          const settings = yield* settingsAt(file);
          const saved = yield* Effect.all(
            [
              settings.update({ model: 'connection:local:a' }),
              settings.update({ wow: 'C:/WoW' }),
              settings.update({ model: 'connection:local:b' }),
            ],
            { concurrency: 'unbounded' },
          );
          assert.deepStrictEqual(saved, [
            { model: 'connection:local:a' },
            { model: 'connection:local:a', wow: 'C:/WoW' },
            { model: 'connection:local:b', wow: 'C:/WoW' },
          ]);
          assert.strictEqual(
            yield* readConfig(file),
            '{\n  "model": "connection:local:b",\n  "wow": "C:/WoW"\n}',
          );
        }),
      );

      it.effect('keeps the saved settings when a write fails', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const failWrites = yield* FailWrites;
          const file = yield* configFile;
          const settings = yield* settingsAt(file);
          yield* settings.update({ wow: 'C:/WoW' });

          yield* Ref.set(failWrites, true);
          const error = yield* Effect.flip(settings.update({ model: 'connection:local:test' }));
          yield* Ref.set(failWrites, false);
          assert.isTrue(PlatformError.isPlatformError(error));
          assert.deepStrictEqual(yield* settings.get, { wow: 'C:/WoW' });
          assert.strictEqual(yield* readConfig(file), '{\n  "wow": "C:/WoW"\n}');
          assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(file)), [
            'config.local.json',
          ]);

          // The next write starts from what was saved, not from the failed patch.
          yield* settings.update({ mcpConfig: 'mcp.json' });
          assert.deepStrictEqual(yield* settings.get, { wow: 'C:/WoW', mcpConfig: 'mcp.json' });
        }),
      );
    });
  },
);
