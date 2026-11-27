import { assert, layer } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { fileURLToPath } from 'node:url';
import { Effect, Fiber, FileSystem, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import * as SecretVault from '../src/platform/secret-vault.ts';

const helper = fileURLToPath(new URL('./secret-helper-fixture.ts', import.meta.url));

/** A vault on the fixture helper, which keeps secrets in a temporary folder. */
const fixtureVault = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-secrets-' });
  return yield* SecretVault.SecretVault.useSync((vault) => vault).pipe(
    Effect.provide(SecretVault.layerHelper({ command: [process.execPath, helper, store] })),
  );
});

layer(NodeServices.layer)('SecretVault', (it) => {
  it.effect('writes a value on stdin and reads it back', () =>
    Effect.gen(function* () {
      const vault = yield* fixtureVault;
      assert.strictEqual(Redacted.value(yield* vault.read('account')), '');
      yield* vault.write('account', Redacted.make('private-é-测试-value'));
      assert.strictEqual(Redacted.value(yield* vault.read('account')), 'private-é-测试-value');
    }),
  );

  it.effect('fails a call whose helper exits with an error', () =>
    Effect.gen(function* () {
      const vault = yield* fixtureVault;
      const error = yield* Effect.flip(vault.read('fails'));
      assert.strictEqual(error.message, 'Native credential storage failed');
    }),
  );

  // The write hits a closed pipe. That must fail the call, not the bridge.
  it.effect('fails a call whose helper exits without reading its input', () =>
    Effect.gen(function* () {
      const vault = yield* fixtureVault;
      const error = yield* Effect.flip(
        vault.write('exits-early', Redacted.make('x'.repeat(4 * 1024 * 1024))),
      );
      assert.strictEqual(error.message, 'Native credential storage failed');
    }),
  );

  it.effect('fails a call whose helper cannot start', () =>
    Effect.gen(function* () {
      const vault = yield* SecretVault.SecretVault.useSync((vault) => vault).pipe(
        Effect.provide(SecretVault.layerHelper({ command: ['wisp-missing-helper.exe'] })),
      );
      const error = yield* Effect.flip(vault.read('key'));
      assert.strictEqual(error.message, 'Native credential storage failed');
    }),
  );

  it.effect('rejects a secret over 1 MiB', () =>
    Effect.gen(function* () {
      const vault = yield* fixtureVault;
      const error = yield* Effect.flip(vault.read('too-large'));
      assert.strictEqual(error.message, 'Secret is too large');
    }),
  );

  it.effect('stops a helper that runs for 10 seconds', () =>
    Effect.gen(function* () {
      const vault = yield* fixtureVault;
      const call = yield* Effect.forkChild(vault.read('hangs'));
      yield* TestClock.adjust('10 seconds');
      const error = yield* Effect.flip(Fiber.join(call));
      assert.strictEqual(error.message, 'Native credential storage timed out');
    }),
  );
});
