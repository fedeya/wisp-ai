import { test } from 'vitest';
import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Layer, Redacted } from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SecretVault from '../src/platform/secret-vault.ts';
import { startDesktopServer } from '../src/api/desktop-server.ts';
test('desktop controls require the session token and reject browser origins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-desktop-'));
  const server = await startDesktopServer(root, { fetch: () => Response.json({ ok: true }) }, 0);
  try {
    const identity = JSON.parse(await readFile(path.join(root, 'desktop.json'), 'utf8'));
    const url = 'http://127.0.0.1:' + identity.port + '/status';
    assert.equal((await fetch(url)).status, 403);
    assert.equal(
      (
        await fetch(url, {
          headers: { authorization: 'Bearer ' + identity.token, origin: 'https://example.com' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url, { headers: { authorization: 'Bearer ' + identity.token } })).status,
      200,
    );
    const oversized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(512 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: 'Request is too large' });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
// Compile the desktop helper first; the test skips without it.
const desktopHelper =
  process.env.WISP_TEST_DESKTOP_EXE ||
  fileURLToPath(new URL('../../desktop/src-tauri/target/release/wisp.exe', import.meta.url));
it.effect.skipIf(process.platform !== 'win32' || !existsSync(desktopHelper))(
  'compiled Windows secret helper round-trips UTF-8 with per-user encryption',
  () =>
    Effect.gen(function* () {
      const vault = yield* SecretVault.SecretVault;
      const key = 'test-' + randomUUID();
      const roundTrip = Effect.fnUntraced(function* (value: string, message: string) {
        yield* vault.write(key, Redacted.make(value));
        assert.equal(Redacted.value(yield* vault.read(key)), value, message);
      });
      yield* Effect.gen(function* () {
        yield* roundTrip('private-é-测试-value', 'the value must round-trip as UTF-8');
        yield* roundTrip('é-测试-'.repeat(10000), 'stdout must be fully drained before resolving');
      }).pipe(Effect.ensuring(Effect.orDie(vault.write(key, Redacted.make('')))));
    }).pipe(
      Effect.provide(
        SecretVault.layerHelper({ command: [desktopHelper] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
