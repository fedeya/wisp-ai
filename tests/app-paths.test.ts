import { assert, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Exit, FileSystem, Layer, Option, Path } from 'effect';
import { HttpClient } from 'effect/http';
import { test } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, cp, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { migrateDesktop } from '@wisp/server/desktop-migration';
import { createHash } from 'node:crypto';

test('the installed bridge can import native adapters from node_modules without TypeScript stripping', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-native-import-'));
  try {
    const source = path.dirname(fileURLToPath(import.meta.resolve('@wisp/agent/package.json')));
    const installed = path.join(temporary, 'node_modules/@wisp/agent');
    await mkdir(installed, { recursive: true });
    await cp(path.join(source, 'dist'), path.join(installed, 'dist'), { recursive: true });
    await cp(path.join(source, 'package.json'), path.join(installed, 'package.json'));
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies)) {
      const link = path.join(temporary, 'node_modules', name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(
        await realpath(path.join(source, 'node_modules', name)),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {modelReasoningEfforts} from '@wisp/agent/reasoning';
      import {createProviderModel} from '@wisp/agent/providers';
      const model = createProviderModel('anthropic', 'claude-sonnet-4-6', {apiKey:'unused', baseURL:'http://127.0.0.1:1'});
      console.log(JSON.stringify({version:model.specificationVersion, efforts:modelReasoningEfforts('anthropic','claude-sonnet-4-6')}));
    `,
      ],
      { cwd: temporary, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout), {
      version: 'v4',
      efforts: ['none', 'low', 'medium', 'high'],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

/** For imports whose previous installation has no bridge to stop. */
const noBridge = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die('The import reached for a bridge')),
);

/** The message of the error an import failed with, if it failed with one. */
const failure = <A, E extends { readonly message: string }>(exit: Exit.Exit<A, E>) =>
  Option.getOrUndefined(Option.map(Exit.findErrorOption(exit), (error) => error.message));

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest, noBridge))((it) => {
  it.effect(
    'migration imports explicit user data, leaves the old installation intact and refuses to overwrite',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-migrate-' });
        const source = path.join(temporary, 'old');
        const destination = path.join(temporary, 'new');
        yield* fs.makeDirectory(path.join(source, 'runtime/memory'), { recursive: true });
        yield* fs.writeFileString(
          path.join(source, 'config.local.json'),
          JSON.stringify({ wow: 'test-wow', model: 'luna' }),
        );
        yield* fs.writeFileString(path.join(source, 'runtime/chats.json'), '["existing chat"]');
        yield* fs.writeFileString(
          path.join(source, 'runtime/desktop.json'),
          'private session identity',
        );
        yield* migrateDesktop({ source, destination, localAppData: '' });
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, 'runtime/chats.json')),
          JSON.stringify(['existing chat'], null, 2),
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(source, 'runtime/chats.json')),
          '["existing chat"]',
        );
        assert.isFalse(yield* fs.exists(path.join(destination, 'runtime/desktop.json')));
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, 'config.local.json')),
          JSON.stringify({ wow: 'test-wow', model: 'luna' }, null, 2),
        );
        assert.strictEqual(
          failure(yield* Effect.exit(migrateDesktop({ source, destination, localAppData: '' }))),
          'This installation is already configured; no data was overwritten.',
        );
      }),
  );

  it.effect('migration preserves encrypted blobs and detaches old Eve session IDs', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-credentials-import-' });
      const source = path.join(temporary, 'old');
      const destination = path.join(temporary, 'new');
      const localAppData = path.join(temporary, 'LocalAppData');
      const secrets = path.join(localAppData, 'WispAI', 'Secrets', sha256(source));
      yield* fs.makeDirectory(secrets, { recursive: true });
      yield* fs.makeDirectory(path.join(source, 'runtime'), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, 'config.local.json'),
        JSON.stringify({ wow: 'test-wow' }),
      );
      yield* fs.writeFileString(
        path.join(source, 'runtime/chats.json'),
        JSON.stringify([
          {
            id: 'chat',
            eveId: 'old-session',
            status: 'working',
            messages: [{ role: 'user', text: 'Keep this' }],
          },
        ]),
      );
      const encrypted = new Uint8Array([0, 1, 2, 3, 255, 128]);
      const blob = path.join(destination, 'secrets', sha256('auth') + '.bin');
      yield* fs.writeFile(path.join(secrets, sha256('auth') + '.bin'), encrypted);
      yield* fs.writeFileString(path.join(secrets, 'not-a-secret.bin'), 'skipped');
      yield* migrateDesktop({ source, destination, localAppData });
      assert.deepStrictEqual(yield* fs.readFile(blob), encrypted);
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(destination, 'secrets')), [
        sha256('auth') + '.bin',
      ]);
      assert.strictEqual(
        yield* fs.readFileString(path.join(destination, 'runtime/chats.json')),
        JSON.stringify(
          [{ id: 'chat', status: 'interrupted', messages: [{ role: 'user', text: 'Keep this' }] }],
          null,
          2,
        ),
      );
      yield* fs.remove(blob);
      assert.strictEqual(
        failure(yield* Effect.exit(migrateDesktop({ source, destination, localAppData }))),
        'This installation is already configured; no data was overwritten.',
      );
      assert.isFalse(yield* fs.exists(blob));
    }),
  );
});
