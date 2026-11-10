import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiskTransport } from '@wisp/bridge/transport';
test('a failed payload write can retry the same snapshot after the filesystem recovers', async () => {
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
