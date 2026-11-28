import { createHash } from 'node:crypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem } from 'effect';
import { adapters } from '../../apps/server/src/integrations/simulation/adapters/index.ts';
import { environmentVariable, environmentVariables } from '../environment.ts';
import {
  nativeBuildKey,
  restoreNativeBinary,
  saveNativeBinary,
  type NativeBuildContext,
} from '../native-cache.ts';
import { verifySimulator } from '../simulator/verify.ts';
import { temporaryDirectory, writeFiles } from './fixtures.ts';

const context: NativeBuildContext = {
  platform: 'win32',
  arch: 'x64',
  rustc: 'rustc pinned compiler',
  cargo: 'cargo pinned version',
  image: 'windows/test-image',
  flags: { CARGO_INCREMENTAL: '0' },
};

const project = (root: string) =>
  writeFiles(root, {
    'apps/desktop/src-tauri/src/main.rs': 'native app',
    'apps/desktop/src-tauri/Cargo.toml': 'lto = "thin"',
    'apps/desktop/src-tauri/Cargo.lock': 'pinned Rust dependencies',
    'apps/desktop/src-tauri/tauri.conf.json': '{}',
    'apps/desktop/src-tauri/icons/icon.ico': 'native icon',
    'apps/desktop/dist/index.html': 'current frontend',
    'apps/desktop/dist/assets/main.js': 'compiled Svelte',
    'apps/desktop/dist/resources/map.json': 'embedded frontend resource',
    'apps/desktop/package.json': '{}',
    'package.json': '{}',
    'pnpm-lock.yaml': 'pinned JavaScript dependencies',
    'scripts/build-desktop.ts': 'release build',
    'scripts/native-cache.ts': 'cache format',
    'scripts/native-cache-key.ts': 'cache input selection',
  });

const failure = <R>(effect: Effect.Effect<unknown, { readonly message: string }, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

layer(NodeServices.layer)((it) => {
  it.effect(
    'native executable reuse ignores external runtime payload but invalidates embedded UI, Rust and configuration changes',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* temporaryDirectory('wisp-native-inputs-');
        yield* project(root);
        const original = yield* nativeBuildKey(root, context);
        yield* writeFiles(root, {
          'apps/agent/src/wisp/tools/example.ts': 'new agent tool',
          'apps/server/src/main.ts': 'updated bridge',
          'addon/WispAI/UI/Window.lua': 'updated addon',
          'apps/desktop/src-tauri/resources/payload/BUILD.json': 'new release commit',
          'apps/desktop/src-tauri/target/release/wisp.exe': 'old build output',
        });
        expect(yield* nativeBuildKey(root, context)).toBe(original);
        for (const file of [
          'apps/desktop/dist/index.html',
          'apps/desktop/dist/resources/map.json',
          'apps/desktop/dist/assets/main.js',
          'apps/desktop/src-tauri/src/main.rs',
          'apps/desktop/src-tauri/tauri.conf.json',
          'apps/desktop/src-tauri/icons/icon.ico',
          'apps/desktop/src-tauri/Cargo.lock',
          'apps/desktop/src-tauri/Cargo.toml',
          'pnpm-lock.yaml',
          'scripts/build-desktop.ts',
        ]) {
          const previous = yield* fs.readFile(`${root}/${file}`);
          yield* writeFiles(root, { [file]: 'changed input' });
          expect(yield* nativeBuildKey(root, context), file).not.toBe(original);
          yield* fs.writeFile(`${root}/${file}`, previous);
        }
        yield* writeFiles(root, {
          '.cargo/config.toml': '[build]\nrustflags = ["-C", "target-cpu=native"]',
        });
        expect(yield* nativeBuildKey(root, context), 'workspace compiler configuration').not.toBe(
          original,
        );
      }),
  );

  it.effect(
    'native executable reuse invalidates compiler, platform, runner image and optimization flags',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory('wisp-native-toolchain-');
        yield* project(root);
        const original = yield* nativeBuildKey(root, context);
        for (const change of [
          { rustc: 'different compiler' },
          { cargo: 'different Cargo' },
          { arch: 'arm64' },
          { image: 'windows/new-SDK-image' },
          { flags: { CARGO_PROFILE_RELEASE_LTO: 'off' } },
        ]) {
          expect(yield* nativeBuildKey(root, { ...context, ...change })).not.toBe(original);
        }
      }),
  );

  it.effect(
    'a cache hit restores identical executable bytes and rejects stale or corrupted binaries',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* temporaryDirectory('wisp-native-binary-');
        const executable = `${root}/original.exe`;
        const destination = `${root}/target/wisp.exe`;
        const cache = `${root}/cache`;
        const binary = Buffer.from([77, 90, 0, 1, 128, 255]);
        yield* fs.writeFile(executable, binary);
        expect(yield* restoreNativeBinary(cache, 'missing', destination)).toBe(false);
        yield* saveNativeBinary(cache, 'current-inputs', executable);
        expect(yield* restoreNativeBinary(cache, 'different-inputs', destination)).toBe(false);
        expect(yield* restoreNativeBinary(cache, 'current-inputs', destination)).toBe(true);
        expect(Buffer.from(yield* fs.readFile(destination))).toEqual(binary);
        yield* fs.writeFileString(destination, 'installer patches only its own copy');
        expect(Buffer.from(yield* fs.readFile(`${cache}/wisp.exe`))).toEqual(binary);
        yield* fs.writeFileString(`${cache}/wisp.exe`, 'corrupted cache');
        expect(yield* restoreNativeBinary(cache, 'current-inputs', destination)).toBe(false);
        yield* fs.writeFileString(`${cache}/build.json`, 'incomplete metadata');
        expect(yield* restoreNativeBinary(cache, 'current-inputs', destination)).toBe(false);
      }),
  );

  it.effect('the build fingerprint reads compiler variables, including ones set to empty', () =>
    Effect.gen(function* () {
      const variables = yield* environmentVariables.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              RUSTFLAGS: '',
              CARGO_PROFILE_RELEASE_LTO: 'off',
              CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: 'lld',
              ITEM_0: 'first',
              ITEM_2: 'third',
            },
          }),
        ),
      );
      expect(Object.fromEntries(variables)).toEqual({
        RUSTFLAGS: '',
        CARGO_PROFILE_RELEASE_LTO: 'off',
        CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: 'lld',
        ITEM_0: 'first',
        ITEM_2: 'third',
      });
      const path = yield* environmentVariable('PATH').pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { Path: 'C:\\Windows' } }),
        ),
      );
      expect(path).toBe(process.platform === 'win32' ? 'C:\\Windows' : '');
    }),
  );

  it.effect(
    'production packaging refuses a simulator that does not match its pinned metadata',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory('wisp-simulator-integrity-');
        const binary = 'pinned compiled simulator';
        yield* writeFiles(root, {
          'simulator/wowsimcli.exe': binary,
          'simulator/manifest.json': JSON.stringify({
            commit: '7f9c0e733fe3f8823407566dd417aca11f833e6f',
            sha256: createHash('sha256').update(binary).digest('hex'),
            supportedClasses: Object.keys(adapters),
          }),
          'simulator/items.json': '[{"id":1},{"id":2}]',
          'simulator/classes.json': JSON.stringify(
            Object.fromEntries(
              Object.values(adapters).map((a) => [
                a.token,
                {
                  talents: [[], [], []],
                  ranks: Object.fromEntries(a.families.map((f) => [f, [{ id: 1, level: 1 }]])),
                },
              ]),
            ),
          ),
        });
        yield* verifySimulator(root);
        yield* writeFiles(root, { 'simulator/wowsimcli.exe': 'different binary' });
        expect(yield* failure(verifySimulator(root))).toContain('pinned manifest');
        yield* writeFiles(root, {
          'simulator/wowsimcli.exe': binary,
          'simulator/items.json': '{}',
        });
        expect(yield* failure(verifySimulator(root))).toContain('Invalid simulator metadata');
      }),
  );
});
