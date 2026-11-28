import { assert, describe, layer } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { ConfigProvider, Effect, FileSystem, Layer, Path } from 'effect';
import * as AppConfig from '#/platform/config';
import * as AppVersion from '#/platform/app-version';

/** The version read from a resource root holding `packageJson`, or none when it is undefined. */
const versionWith = (packageJson: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-version-' });
    if (packageJson !== undefined) {
      yield* fs.writeFileString(path.join(root, 'package.json'), packageJson);
    }
    return yield* AppVersion.AppVersion.useSync(({ version }) => version).pipe(
      Effect.provide(AppVersion.layer.pipe(Layer.provide(AppConfig.layer))),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { WISP_RESOURCE_ROOT: root } }),
      ),
    );
  });

layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))('AppVersion', (it) => {
  describe('reading package.json at the resource root', () => {
    it.effect('reads its version', () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* versionWith(JSON.stringify({ name: 'wisp-ai', version: '0.3.2-nightly.4.1' })),
          '0.3.2-nightly.4.1',
        );
      }),
    );

    it.effect('reads a missing, unreadable or versionless file as unknown', () =>
      Effect.gen(function* () {
        for (const packageJson of [
          undefined,
          '{broken',
          JSON.stringify({}),
          JSON.stringify({ version: '' }),
        ]) {
          assert.strictEqual(yield* versionWith(packageJson), 'unknown');
        }
      }),
    );
  });
});
