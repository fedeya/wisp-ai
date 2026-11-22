import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiskTransport } from '../src/addon/transport.ts';
test('a failed payload write can retry the same snapshot after the filesystem recovers', async () => {
  await mkdir(path.resolve('runtime'), { recursive: true });
  const root = await mkdtemp(path.resolve('runtime', 'transport-retry-'));
  const blocker = path.join(root, 'Interface');
  const bridge = new DiskTransport(root, () => {});
  try {
    await writeFile(blocker, 'not a directory');
    await assert.rejects(bridge.publish({ rev: 1, text: 'retry me' }));
    await rm(blocker);
    await bridge.publish({ rev: 1, text: 'retry me' });
    assert.ok(
      (
        await readFile(path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua'), 'utf8')
      ).includes('retry me'),
    );
  } finally {
    bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test('payload writes stay ordered and acknowledgements never rewind the receive cursor', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-test-'));
  const bridge = new DiskTransport(root, () => {});
  try {
    await Promise.all([
      bridge.publish({ v: 1, rev: 1, text: 'first' }),
      bridge.publish({ v: 1, rev: 2, text: 'second' }),
    ]);
    bridge.setCursor(2, 1);
    await bridge.writing;
    const payload = await readFile(
      path.join(root, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua'),
      'utf8',
    );
    assert.ok(payload.includes('second'));
    bridge.setCursor(3, 2);
    await bridge.writing;
    bridge.setCursor(1, 2);
    assert.equal(bridge.nextSlot, 3, 'late packets cannot rewind the slot');
    bridge.setCursor(4, 1);
    await bridge.writing;
    assert.equal(
      bridge.peerRevision,
      2,
      'an old queued packet cannot undo a newer acknowledgement and make consumed data look unread',
    );
    bridge.resetSession();
    assert.equal(bridge.peerRevision, 0);
    assert.equal(bridge.nextSlot, 1);
    await bridge.publish({ v: 1, rev: 3, text: 'fresh session' });
  } finally {
    bridge.stop();
    assert.ok(path.resolve(root).startsWith(base + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
test('a failing folder watcher is dropped and rewatched instead of ending the bridge', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-watch-'));
  const character = path.join(root, 'WTF', 'Account', 'ACCOUNT', 'Realm', 'Hero');
  await mkdir(character, { recursive: true });
  await writeFile(path.join(character, 'AddOns.txt'), 'WispAI: enabled\n');
  const errors: unknown[] = [];
  const bridge = new DiskTransport(
    root,
    () => {},
    (error) => errors.push(error),
  );
  try {
    await bridge.start();
    const first = bridge.watchers.get(character);
    assert.ok(first, 'the character folder is watched');
    // Without a listener this 'error' would be an uncaught exception.
    first.emit('error', new Error('folder removed'));
    assert.equal(bridge.watchers.has(character), false);
    assert.equal((errors[0] as Error).message, 'folder removed');
    await bridge.scan(false);
    const second = bridge.watchers.get(character);
    assert.ok(second && second !== first, 'the next scan watches the folder again');
  } finally {
    await bridge.stop();
    assert.equal(bridge.watchers.size, 0);
    await rm(root, { recursive: true, force: true });
  }
});
