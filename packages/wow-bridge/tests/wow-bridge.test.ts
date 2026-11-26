import { expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Exit, FileSystem, Layer, Scope, Stream } from 'effect';
import { encodeMessage, readUplink, replaceUplink, UPLINK_KIND } from '../src/mailbox.ts';
import { layer, WowBridge, type GameEvent } from '../src/wow-bridge.ts';

test('the connection publishes and resolves game requests without routing them through the host', async () => {
  const runtime = path.resolve('runtime');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'bridge-api-'));
  const file = path.join(root, 'WTF/Account/Account/Realm/Hero/AddOns.txt');
  const payload = path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua');
  const scope = Scope.makeUnsafe();
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const errors: unknown[] = [];
  const events: GameEvent[] = [];
  let lastRead: Buffer | null = null;
  const observeReads = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      readFileString: (filename, encoding) =>
        fs.readFileString(filename, encoding).pipe(
          Effect.tap((text) =>
            Effect.sync(() => {
              if (filename === file) lastRead = readUplink(text);
            }),
          ),
        ),
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  let sequence = 0;
  let wireSequence = 0;
  async function send(packet: { type: string; session: string } & Record<string, unknown>) {
    const body = Buffer.from(
      JSON.stringify({ ...packet, at: ++sequence, seq: sequence, transportVersion: 2 }),
    );
    const frames = encodeMessage(body, UPLINK_KIND, 1, wireSequence);
    wireSequence += frames.length;
    for (const frame of frames) {
      await writeFile(file, replaceUplink(await readFile(file, 'utf8'), frame));
      await vi.waitFor(() => expect(lastRead).toEqual(frame), { timeout: 2500 });
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
    await writeFile(file, 'WispAI: enabled\n');
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* WowBridge;
        const connection = yield* bridge.open(root, {
          onError: (error) => errors.push(error),
          onTimeout: vi.fn(),
          onHeldOff: vi.fn(),
          onSlowDownlink: vi.fn(),
        });
        yield* connection.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped(),
        );
        return connection;
      }).pipe(
        Scope.provide(scope),
        Effect.provide(layer.pipe(Layer.provide([observeReads, NodePath.layer]))),
      ),
    );
    await send({ type: 'hello', session: 'one', nextSlot: 1 });
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2500 });
    expect(events[0]).toMatchObject({ type: 'hello', session: 'one' });
    expect(events[0]).not.toHaveProperty('nextSlot');
    const view = { v: 1, session: 'one', connected: true, acks: [1] };
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

    const removed = Effect.runPromise(connection.request({ ...call, chat: 'removed' }));
    const deleted = expect(removed).rejects.toThrow('Conversation deleted');
    expect(await requestId('removed')).not.toBe(id);
    await send({ type: 'delete', session: 'one', chat: 'removed' });
    await deleted;
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('delete'));

    const next = Effect.runPromise(connection.request(call));
    const reloaded = expect(next).rejects.toThrow('reloaded');
    expect(await requestId()).not.toBe(id);
    await send({ type: 'hello', session: 'two' });
    await reloaded;
    await expect(Effect.runPromise(connection.request(call))).rejects.toThrow(
      'No active connection',
    );
    const inFlight = Effect.runPromise(connection.request({ ...call, session: 'two' }));
    const stopped = expect(inFlight).rejects.toThrow('Bridge stopped');
    await close();
    await stopped;
    expect(connection.status()).toEqual({
      session: undefined,
      readyPublished: false,
      ready: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
