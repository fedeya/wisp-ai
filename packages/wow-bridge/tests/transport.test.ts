import { expect, test, vi } from 'vitest';
import { Deferred, Effect, Stream } from 'effect';
import { systemError, type PlatformError } from 'effect/PlatformError';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openTransport } from './transport-fixture.ts';
import { captureLogs } from './log-fixture.ts';
import { encodeMessage, replaceUplink, UPLINK_KIND } from '../src/wire/mailbox.ts';
test('a failed payload write can retry the same snapshot after the filesystem recovers', async () => {
  await mkdir(path.resolve('runtime'), { recursive: true });
  const root = await mkdtemp(path.resolve('runtime', 'transport-retry-'));
  const blocker = path.join(root, 'Interface');
  const { bridge, close } = await openTransport([root, () => {}]);
  try {
    await writeFile(blocker, 'not a directory');
    await expect(Effect.runPromise(bridge.publish({ rev: 1, text: 'retry me' }))).rejects.toThrow();
    await rm(blocker);
    await Effect.runPromise(bridge.publish({ rev: 1, text: 'retry me' }));
    expect(
      await readFile(path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua'), 'utf8'),
    ).toContain('retry me');
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
test('payload writes stay ordered and acknowledgements never rewind the receive cursor', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-test-'));
  const { bridge, close } = await openTransport([root, () => {}]);
  try {
    await Promise.all([
      Effect.runPromise(bridge.publish({ v: 1, rev: 1, text: 'first' })),
      Effect.runPromise(bridge.publish({ v: 1, rev: 2, text: 'second' })),
    ]);
    await Effect.runPromise(bridge.setCursor(2, 1));
    await Effect.runPromise(bridge.waitForWrites());
    const payload = await readFile(
      path.join(root, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua'),
      'utf8',
    );
    expect(payload).toContain('second');
    await Effect.runPromise(bridge.setCursor(3, 2));
    await Effect.runPromise(bridge.waitForWrites());
    await Effect.runPromise(bridge.setCursor(1, 2));
    expect(bridge.nextSlot, 'late packets cannot rewind the slot').toBe(3);
    await Effect.runPromise(bridge.setCursor(4, 1));
    await Effect.runPromise(bridge.waitForWrites());
    expect(
      bridge.peerRevision,
      'an old queued packet cannot undo a newer acknowledgement and make consumed data look unread',
    ).toBe(2);
    await Effect.runPromise(bridge.resetSession());
    expect(bridge.peerRevision).toBe(0);
    expect(bridge.nextSlot).toBe(1);
    await Effect.runPromise(bridge.publish({ v: 1, rev: 3, text: 'fresh session' }));
  } finally {
    await close();
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
  const logs = captureLogs();
  const failed = Deferred.makeUnsafe<never, PlatformError>();
  let attempts = 0;
  const { bridge, close } = await openTransport(
    [root, () => {}],
    (fs) => ({
      ...fs,
      watch: (dir, options) =>
        ++attempts === 1 ? Stream.fromEffect(Deferred.await(failed)) : fs.watch(dir, options),
    }),
    logs.layer,
  );
  try {
    await Effect.runPromise(bridge.start());
    expect(bridge.watchers.has(character)).toBe(true);
    const error = systemError({ _tag: 'NotFound', module: 'FileSystem', method: 'watch' });
    await Effect.runPromise(Deferred.fail(failed, error));
    await vi.waitFor(() => expect(bridge.watchers.has(character)).toBe(false));
    expect(logs.entries('transport.failed')).toEqual([{ error: error.message }]);
    await Effect.runPromise(bridge.scan(false));
    expect(attempts).toBe(2);
    expect(bridge.watchers.has(character)).toBe(true);
  } finally {
    await close();
    expect(bridge.watchers.size).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed startup read does not turn a persisted hello into a live event', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-baseline-'));
  const file = path.join(root, 'WTF/Account/Account/Realm/Hero/AddOns.txt');
  const receive = vi.fn();
  const logs = captureLogs();
  const denied = systemError({
    _tag: 'PermissionDenied',
    module: 'FileSystem',
    method: 'readFileString',
  });
  let readable = false;
  const { bridge, close } = await openTransport(
    [root, receive],
    (fs) => ({
      ...fs,
      readFileString: (name, encoding) =>
        name === file && !readable ? Effect.fail(denied) : fs.readFileString(name, encoding),
    }),
    logs.layer,
  );
  const hello = { type: 'hello', session: 'old', seq: 1, at: 1, transportVersion: 2 };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const [frame] = encodeMessage(Buffer.from(JSON.stringify(hello)), UPLINK_KIND, 1);
    await writeFile(file, replaceUplink('', frame));
    await Effect.runPromise(bridge.start().pipe(Effect.provide(logs.layer)));
    expect(logs.entries('transport.failed')).toContainEqual({ error: denied.message });
    readable = true;
    await Effect.runPromise(bridge.read(file, false));
    expect(receive).not.toHaveBeenCalled();
    const [fresh] = encodeMessage(
      Buffer.from(JSON.stringify({ ...hello, seq: 2, at: 2 })),
      UPLINK_KIND,
      1,
      1,
    );
    await writeFile(file, replaceUplink(await readFile(file, 'utf8'), fresh));
    await Effect.runPromise(bridge.read(file, false));
    expect(receive).toHaveBeenCalledExactlyOnceWith({ ...hello, seq: 2, at: 2 });
  } finally {
    await close();
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
    const { bridge, close } = await openTransport([root, () => {}]);
    const scan = bridge.scan.bind(bridge);
    const error = systemError({
      _tag: 'Busy',
      module: 'FileSystem',
      method: 'readDirectoryEntries',
    });
    vi.spyOn(bridge, 'scan').mockImplementation((baseline) =>
      scan(baseline).pipe(
        Effect.tap(() => Effect.sync(() => expect(bridge.watchers.size).toBe(1))),
        Effect.andThen(Effect.fail(error)),
      ),
    );
    try {
      await expect(Effect.runPromise(bridge.start())).rejects.toBe(error);
    } finally {
      await close();
    }
    expect(bridge.stopped).toBe(true);
    expect(bridge.watchers.size).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('closing the connection interrupts its workers and waits for an in-flight payload write', async () => {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-drain-'));
  const writing = Deferred.makeUnsafe<void>();
  const releaseWrite = Deferred.makeUnsafe<void>();
  const { bridge, close } = await openTransport([root, () => {}], (fs) => ({
    ...fs,
    writeFileString: (file, data, options) =>
      Deferred.succeed(writing, undefined).pipe(
        Effect.andThen(Deferred.await(releaseWrite)),
        Effect.andThen(fs.writeFileString(file, data, options)),
      ),
  }));
  try {
    await Effect.runPromise(bridge.start());
    const publish = Effect.runPromise(bridge.publish({ rev: 1, text: 'in flight' }));
    await Effect.runPromise(Deferred.await(writing));
    const closed = vi.fn();
    const shutdown = close().then(closed);
    expect(bridge.stopped).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined));
    await Promise.all([publish, shutdown]);
    expect(closed).toHaveBeenCalledOnce();
    expect(
      await readFile(path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua'), 'utf8'),
    ).toContain('in flight');
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
