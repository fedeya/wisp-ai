import { test } from 'vitest';
import { adapters } from '../../apps/bridge/src/simulation/adapters/index.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  nativeBuildKey,
  restoreNativeBinary,
  saveNativeBinary,
  type NativeBuildContext,
} from '../native-cache.ts';
import { verifySimulator } from '../verify-simulator.ts';

const context: NativeBuildContext = {
  platform: 'win32',
  arch: 'x64',
  rustc: 'rustc pinned compiler',
  cargo: 'cargo pinned version',
  image: 'windows/test-image',
  flags: { CARGO_INCREMENTAL: '0' },
};
async function put(root: string, file: string, contents: string | Buffer) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), contents);
}
async function project(root: string) {
  for (const [file, contents] of Object.entries({
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
  })) {
    await put(root, file, contents);
  }
}

test('native executable reuse ignores external runtime payload but invalidates embedded UI, Rust and configuration changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-native-inputs-'));
  try {
    await project(root);
    const original = await nativeBuildKey(root, context);
    await put(root, 'apps/agent/agent/tools/example.ts', 'new agent tool');
    await put(root, 'apps/bridge/src/main.ts', 'updated bridge');
    await put(root, 'addon/WispAI/UI.lua', 'updated addon');
    await put(root, 'apps/desktop/src-tauri/resources/payload/BUILD.json', 'new release commit');
    await put(root, 'apps/desktop/src-tauri/target/release/wisp.exe', 'old build output');
    assert.equal(await nativeBuildKey(root, context), original);
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
      const previous = await readFile(path.join(root, file));
      await put(root, file, 'changed input');
      assert.notEqual(await nativeBuildKey(root, context), original, file);
      await put(root, file, previous);
    }
    await put(root, '.cargo/config.toml', '[build]\nrustflags = ["-C", "target-cpu=native"]');
    assert.notEqual(
      await nativeBuildKey(root, context),
      original,
      'workspace compiler configuration',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native executable reuse invalidates compiler, platform, runner image and optimization flags', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-native-toolchain-'));
  try {
    await project(root);
    const original = await nativeBuildKey(root, context);
    for (const change of [
      { rustc: 'different compiler' },
      { cargo: 'different Cargo' },
      { arch: 'arm64' },
      { image: 'windows/new-SDK-image' },
      { flags: { CARGO_PROFILE_RELEASE_LTO: 'off' } },
    ]) {
      assert.notEqual(await nativeBuildKey(root, { ...context, ...change }), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cache hit restores identical executable bytes and rejects stale or corrupted binaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-native-binary-'));
  try {
    const executable = path.join(root, 'original.exe');
    const destination = path.join(root, 'target/wisp.exe');
    const cache = path.join(root, 'cache');
    const binary = Buffer.from([77, 90, 0, 1, 128, 255]);
    await writeFile(executable, binary);
    assert.equal(await restoreNativeBinary(cache, 'missing', destination), false);
    await saveNativeBinary(cache, 'current-inputs', executable);
    assert.equal(await restoreNativeBinary(cache, 'different-inputs', destination), false);
    assert.equal(await restoreNativeBinary(cache, 'current-inputs', destination), true);
    assert.deepEqual(await readFile(destination), binary);
    await writeFile(destination, 'installer patches only its own copy');
    assert.deepEqual(await readFile(path.join(cache, 'wisp.exe')), binary);
    await writeFile(path.join(cache, 'wisp.exe'), 'corrupted cache');
    assert.equal(await restoreNativeBinary(cache, 'current-inputs', destination), false);
    await writeFile(path.join(cache, 'build.json'), 'incomplete metadata');
    assert.equal(await restoreNativeBinary(cache, 'current-inputs', destination), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production packaging refuses a simulator that does not match its pinned metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-simulator-integrity-'));
  try {
    const binary = Buffer.from('pinned compiled simulator');
    await put(root, 'simulator/wowsimcli.exe', binary);
    await put(
      root,
      'simulator/manifest.json',
      JSON.stringify({
        commit: '7f9c0e733fe3f8823407566dd417aca11f833e6f',
        sha256: createHash('sha256').update(binary).digest('hex'),
        supportedClasses: Object.keys(adapters),
      }),
    );
    await put(root, 'simulator/items.json', '[{"id":1},{"id":2}]');
    await put(
      root,
      'simulator/classes.json',
      JSON.stringify(
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
    );
    await verifySimulator(root);
    await put(root, 'simulator/wowsimcli.exe', 'different binary');
    await assert.rejects(verifySimulator(root), /pinned manifest/);
    await put(root, 'simulator/wowsimcli.exe', binary);
    await put(root, 'simulator/items.json', '{}');
    await assert.rejects(verifySimulator(root), /Invalid simulator metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
