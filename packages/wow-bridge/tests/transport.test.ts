import { expect, test, vi } from 'vitest';
import { Effect, Exit, Scope } from 'effect';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DiskTransport } from '../src/transport.ts';
test('a failed payload write can retry the same snapshot after the filesystem recovers', async () => {
  await mkdir(path.resolve('runtime'), { recursive: true });
  const root = await mkdtemp(path.resolve('runtime', 'transport-retry-'));
  const blocker = path.join(root, 'Interface');
  const bridge = new DiskTransport(root, () => {});
  try {
    await writeFile(blocker, 'not a directory');
    await expect(bridge.publish({ rev: 1, text: 'retry me' })).rejects.toThrow();
    await rm(blocker);
    await bridge.publish({ rev: 1, text: 'retry me' });
    expect(
      await readFile(path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua'), 'utf8'),
    ).toContain('retry me');
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
    expect(payload).toContain('second');
    bridge.setCursor(3, 2);
    await bridge.writing;
    bridge.setCursor(1, 2);
    expect(bridge.nextSlot, 'late packets cannot rewind the slot').toBe(3);
    bridge.setCursor(4, 1);
    await bridge.writing;
    expect(
      bridge.peerRevision,
      'an old queued packet cannot undo a newer acknowledgement and make consumed data look unread',
    ).toBe(2);
    bridge.resetSession();
    expect(bridge.peerRevision).toBe(0);
    expect(bridge.nextSlot).toBe(1);
    await bridge.publish({ v: 1, rev: 3, text: 'fresh session' });
  } finally {
    bridge.stop();
    expect(path.resolve(root).startsWith(base + path.sep)).toBeTruthy();
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
  const scope = Scope.makeUnsafe();
  const bridge = new DiskTransport(
    root,
    () => {},
    (error) => errors.push(error),
  );
  try {
    await Effect.runPromise(Scope.provide(bridge.start(), scope));
    const first = bridge.watchers.get(character);
    expect(first, 'the character folder is watched').toBeTruthy();
    // Without a listener this 'error' would be an uncaught exception.
    first!.emit('error', new Error('folder removed'));
    expect(bridge.watchers.has(character)).toBe(false);
    expect((errors[0] as Error).message).toBe('folder removed');
    await bridge.scan(false);
    const second = bridge.watchers.get(character);
    expect(second && second !== first, 'the next scan watches the folder again').toBeTruthy();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(bridge.watchers.size).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed baseline scan releases watchers already opened in the connection scope', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-start-'));
  try {
    const character = path.join(root, 'WTF', 'Account', 'ACCOUNT', 'Realm', 'Hero');
    await mkdir(character, { recursive: true });
    await writeFile(path.join(character, 'AddOns.txt'), 'WispAI: enabled\n');
    const bridge = new DiskTransport(root, () => {});
    const scan = bridge.scan.bind(bridge);
    vi.spyOn(bridge, 'scan').mockImplementation(async (baseline) => {
      await scan(baseline);
      expect(bridge.watchers.size).toBe(1);
      throw Error('baseline scan failed');
    });
    await expect(Effect.runPromise(Effect.scoped(bridge.start()))).rejects.toThrow(
      'baseline scan failed',
    );
    expect(bridge.stopped).toBe(true);
    expect(bridge.watchers.size).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
