import { expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Deferred, Effect, Exit, FileSystem, Layer, Scope, Stream } from 'effect';
import { encodeMessage, readUplink, replaceUplink, UPLINK_KIND } from '../src/wire/mailbox.ts';
import { layer, WowBridge, type GameEvent } from '../src/wow-bridge.ts';
import { captureLogs } from './log-fixture.ts';

test('the connection publishes and resolves game requests without routing them through the host', async () => {
  const runtime = path.resolve('runtime');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'bridge-api-'));
  const file = path.join(root, 'WTF/Account/Account/Realm/Hero/AddOns.txt');
  const otherFile = path.join(root, 'WTF/Account/Account/Realm/Other/AddOns.txt');
  const payload = path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua');
  const scope = Scope.makeUnsafe();
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const logs = captureLogs();
  const events: GameEvent[] = [];
  const lastRead = new Map<string, Buffer | null>();
  const writeStarted = Deferred.makeUnsafe<void>();
  const releaseWrite = Deferred.makeUnsafe<void>();
  let holdPayload = false;
  const observeReads = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      readFileString: (filename, encoding) =>
        fs.readFileString(filename, encoding).pipe(
          Effect.tap((text) =>
            Effect.sync(() => {
              if (filename === file || filename === otherFile) {
                lastRead.set(filename, readUplink(text));
              }
            }),
          ),
        ),
      writeFileString: (filename, data, options) => {
        const write = fs.writeFileString(filename, data, options);
        return holdPayload && filename === payload + '.tmp'
          ? Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWrite)),
              Effect.andThen(write),
            )
          : write;
      },
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  let sequence = 0;
  let wireSequence = 0;
  async function send(
    packet: { type: string; session: string } & Record<string, unknown>,
    target = file,
  ) {
    const body = Buffer.from(
      JSON.stringify({ at: ++sequence, seq: sequence, ...packet, transportVersion: 2 }),
    );
    const frames = encodeMessage(body, UPLINK_KIND, 1, wireSequence);
    wireSequence += frames.length;
    for (const frame of frames) {
      await writeFile(target, replaceUplink(await readFile(target, 'utf8'), frame));
      await vi.waitFor(() => expect(lastRead.get(target)).toEqual(frame), { timeout: 2500 });
    }
  }
  async function requestId(chat = 'chat') {
    return vi.waitFor(async () => {
      const data = await readFile(payload, 'utf8');
      const match = data.match(new RegExp(`"requests":\\[\\{"id":"([^"]+)","chat":"${chat}"`));
      expect(match).not.toBeNull();
      return match![1];
    });
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(otherFile), { recursive: true });
    await writeFile(file, 'WispAI: enabled\n');
    await writeFile(otherFile, 'WispAI: enabled\n');
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* WowBridge;
        const connection = yield* bridge.open(root);
        yield* connection.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped(),
        );
        return connection;
      }).pipe(
        Scope.provide(scope),
        Effect.provide(layer.pipe(Layer.provide([observeReads, NodePath.layer]))),
        Effect.provide(logs.layer),
      ),
    );
    await send({ type: 'hello', session: 'one', nextSlot: 1 });
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2500 });
    expect(events[0]).toMatchObject({ type: 'hello', session: 'one' });
    expect(events[0]).not.toHaveProperty('nextSlot');
    expect(events[0]).not.toHaveProperty('seq');
    const view = { v: 1, session: 'one', connected: true };
    await Effect.runPromise(connection.publish(view));
    const call = {
      session: 'one',
      chat: 'chat',
      operation: { kind: 'read' as const, sections: ['gear'] },
    };
    const result = Effect.runPromise(connection.request(call));
    const id = await requestId();
    await send({
      type: 'state_result',
      session: 'one',
      requestId: id,
      chat: 'chat',
      data: { ready: true },
    });
    await expect(result).resolves.toEqual({ ready: true });
    await vi.waitFor(async () => {
      const data = await readFile(payload, 'utf8');
      expect(data).toContain('"acks":[1,2]');
      expect(data).toContain('"requests":[]');
    });
    expect(events.map((event) => event.type)).toEqual(['hello']);
    expect(connection.status()).toMatchObject({ readyPublished: true, ready: false });
    const revision = Number((await readFile(payload, 'utf8')).match(/"rev":(\d+)/)?.[1]);
    expect(revision).toBeGreaterThan(0);
    await send({ type: 'poll', session: 'one', nextSlot: 2, receivedRev: revision });
    await vi.waitFor(() => expect(connection.status().ready).toBe(true));

    const say = {
      type: 'say',
      session: 'one',
      seq: 42,
      chat: 'chat',
      text: 'Hello',
      messageId: 'message',
    };
    await send(say);
    const acknowledged = await vi.waitFor(async () => {
      const data = await readFile(payload, 'utf8');
      expect(data).toContain('"acks":[1,2,42]');
      return data;
    });
    // The same application packet has a fresh mailbox frame sequence when retried.
    await send(say);
    await vi.waitFor(async () => {
      const data = await readFile(payload, 'utf8');
      expect(data).toContain('"acks":[1,2,42]');
      expect(data).not.toBe(acknowledged);
    });
    expect(events.filter((event) => event.type === 'say')).toEqual([
      expect.objectContaining({ chat: 'chat', messageId: 'message', text: 'Hello' }),
    ]);

    const removed = Effect.runPromise(connection.request({ ...call, chat: 'removed' }));
    const deleted = expect(removed).rejects.toThrow('Conversation deleted');
    expect(await requestId('removed')).not.toBe(id);
    await send({ type: 'delete', session: 'one', chat: 'removed' });
    await deleted;
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('delete'));

    const next = Effect.runPromise(connection.request(call));
    const reloaded = expect(next).rejects.toThrow('reloaded');
    expect(await requestId()).not.toBe(id);
    const stoppedView = await readFile(payload, 'utf8');
    holdPayload = true;
    const staleView = { ...view, text: 'stale view' };
    await Effect.runPromise(connection.publish(staleView));
    await Effect.runPromise(Deferred.await(writeStarted).pipe(Effect.timeout(2500)));
    await send({ type: 'hello', session: 'two' }, otherFile);
    await reloaded;
    await expect(Effect.runPromise(connection.request(call))).rejects.toThrow(
      'No active connection',
    );
    expect(connection.status()).toEqual({
      session: 'two',
      readyPublished: false,
      ready: false,
    });
    holdPayload = false;
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined));
    await vi.waitFor(() => expect(events.at(-1)?.session).toBe('two'));
    const inFlight = Effect.runPromise(connection.request({ ...call, session: 'two' }));
    const stopped = expect(inFlight).rejects.toThrow('Bridge stopped');
    await close();
    await stopped;
    expect(await readFile(payload, 'utf8')).toBe(stoppedView);
    expect(connection.status()).toEqual({
      session: undefined,
      readyPublished: false,
      ready: false,
    });
    expect(logs.entries('transport.failed')).toEqual([]);
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
