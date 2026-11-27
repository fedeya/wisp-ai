import { assert, describe, it, layer } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect';
import * as AppConfig from '../src/app-config.ts';

/** Reads `AppConfig` from `env` alone, as the native host would set it. */
const readConfig = (env: Record<string, string>) =>
  AppConfig.AppConfig.useSync((config) => config).pipe(
    Effect.provide(AppConfig.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  );

describe('AppConfig', () => {
  it.effect('defaults to the repository root and keeps data there', () =>
    Effect.gen(function* () {
      const { paths, releaseBuild, telemetryRelease, deferWowTransport } = yield* readConfig({});
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      assert.strictEqual(paths.root, root);
      assert.strictEqual(paths.dataRoot, root);
      assert.strictEqual(paths.runtime, path.join(root, 'runtime'));
      assert.strictEqual(paths.legacyEngine, undefined);
      assert.isFalse(releaseBuild);
      assert.isFalse(telemetryRelease);
      assert.isFalse(deferWowTransport);
    }),
  );

  it.effect('keeps user data in WISP_DATA_DIR, apart from the resources', () =>
    Effect.gen(function* () {
      const root = path.resolve('/app');
      const data = path.resolve('/user');
      const { paths } = yield* readConfig({ WISP_RESOURCE_ROOT: root, WISP_DATA_DIR: data });
      assert.strictEqual(paths.root, root);
      assert.strictEqual(paths.dataRoot, data);
      assert.strictEqual(paths.config, path.join(data, 'config.local.json'));
      assert.strictEqual(paths.legacyEngine, path.join(data, 'engine'));
      const empty = yield* readConfig({ WISP_RESOURCE_ROOT: root, WISP_DATA_DIR: '' });
      assert.strictEqual(empty.paths.dataRoot, root);
      assert.strictEqual(empty.paths.legacyEngine, undefined);
    }),
  );

  it.effect('locates the simulator under the root', () =>
    Effect.gen(function* () {
      const { paths } = yield* readConfig({ WISP_RESOURCE_ROOT: '/app' });
      assert.strictEqual(
        paths.simulatorExecutable,
        path.join('/app', 'simulator', 'wowsimcli.exe'),
      );
    }),
  );

  it.effect('defaults the desktop executable to the release build', () =>
    Effect.gen(function* () {
      const { paths } = yield* readConfig({ WISP_RESOURCE_ROOT: '/app', WISP_DESKTOP_EXE: '' });
      assert.strictEqual(
        paths.desktopExecutable,
        path.join(
          '/app',
          'apps',
          'desktop',
          'src-tauri',
          'target',
          'release',
          process.platform === 'win32' ? 'wisp.exe' : 'wisp',
        ),
      );
    }),
  );

  it.effect('prefers WISP_DESKTOP_EXE for the desktop executable', () =>
    Effect.gen(function* () {
      const { paths } = yield* readConfig({ WISP_DESKTOP_EXE: '/custom/wisp' });
      assert.strictEqual(paths.desktopExecutable, '/custom/wisp');
    }),
  );

  it.effect('turns flags on only with 1', () =>
    Effect.gen(function* () {
      const on = yield* readConfig({
        WISP_RELEASE_BUILD: '1',
        WISP_TELEMETRY_RELEASE: '1',
        WISP_DEFER_WOW_TRANSPORT: '1',
      });
      assert.isTrue(on.releaseBuild);
      assert.isTrue(on.telemetryRelease);
      assert.isTrue(on.deferWowTransport);
      const other = yield* readConfig({ WISP_RELEASE_BUILD: 'true', WISP_TELEMETRY_RELEASE: '0' });
      assert.isFalse(other.releaseBuild);
      assert.isFalse(other.telemetryRelease);
    }),
  );
});

layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))('retireLegacyEngine', (it) => {
  it.effect('removes the Eve engine folder of a separate data folder only', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-engine-retire-' });
      const { paths } = yield* readConfig({
        WISP_RESOURCE_ROOT: path.join(temporary, 'resources'),
        WISP_DATA_DIR: path.join(temporary, 'user'),
      });
      const engine = paths.legacyEngine;
      assert.isDefined(engine);
      yield* fs.makeDirectory(path.join(engine, '.eve/.workflow-data'), { recursive: true });
      yield* fs.writeFileString(path.join(engine, '.eve/.workflow-data/run.json'), '{}');
      yield* fs.makeDirectory(paths.runtime, { recursive: true });
      yield* fs.writeFileString(path.join(paths.runtime, 'wisp.sqlite'), 'keep');

      yield* AppConfig.retireLegacyEngine(engine);
      assert.isFalse(yield* fs.exists(engine));
      assert.strictEqual(yield* fs.readFileString(path.join(paths.runtime, 'wisp.sqlite')), 'keep');

      // Only a folder named engine is ever removed.
      yield* AppConfig.retireLegacyEngine(paths.runtime);
      assert.strictEqual(yield* fs.readFileString(path.join(paths.runtime, 'wisp.sqlite')), 'keep');
      yield* AppConfig.retireLegacyEngine(undefined);
    }),
  );
});
