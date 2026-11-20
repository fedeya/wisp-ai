import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeVault } from '../src/auth/secret-vault.ts';
import { startDesktopServer } from '../src/desktop/desktop-server.ts';
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
      body: JSON.stringify({ padding: 'x'.repeat(100001) }),
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: 'Request is too large' });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
test(
  'compiled Windows secret helper round-trips UTF-8 with per-user encryption',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const exe =
      process.env.WISP_TEST_DESKTOP_EXE ||
      fileURLToPath(new URL('../../desktop/src-tauri/target/release/wisp.exe', import.meta.url));
    try {
      await access(exe);
    } catch {
      t.skip('Compile desktop helper first');
      return;
    }
    const vault = new NativeVault(exe),
      key = 'test-' + Date.now();
    try {
      await vault.write(key, 'private-é-测试-value');
      assert.equal(await vault.read(key), 'private-é-测试-value');
      const large = 'é-测试-'.repeat(10000);
      await vault.write(key, large);
      assert.equal(await vault.read(key), large, 'stdout must be fully drained before resolving');
    } finally {
      await vault.write(key, '');
    }
  },
);
