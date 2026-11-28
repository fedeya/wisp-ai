import { expect, test, vi } from 'vitest';
import { Effect, type FileSystem } from 'effect';
import { systemError } from 'effect/PlatformError';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { ACTIVE_SESSION_MS, type DiskConnection } from '../src/connection.ts';
import { SLOW_DOWNLINK_MS, preferBulkDelivery } from '../src/delivery.ts';
import type { Packet } from '../src/wire/protocol.ts';
import {
  DOWNLINK_HELPERS,
  DOWNLINK_KIND,
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  COMPRESSED,
  MailboxDecoder,
  MAX_DECODED_BYTES,
  UPLINK_HELPERS,
  UPLINK_KIND,
  encodeMessage,
  encodeFrame,
  decodeFrame,
  readDownlink,
  readUplink,
  replaceUplink,
  inflateMessage,
} from '../src/wire/mailbox.ts';
import { applyDownlink } from '../src/wire/downlink.ts';
import { openTransport } from './transport-fixture.ts';
import { captureLogs } from './log-fixture.ts';

async function fixture(
  receive: (packet: Packet, bridge: DiskConnection) => void = () => {},
  realm = 'realm',
  overrideFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
) {
  const base = path.resolve('runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transport-v2-'));
  const file = path.join(root, 'WTF/Account/account', realm, 'character/AddOns.txt');
  const payload = path.join(root, 'Interface/AddOns/WispAI_Payload/Payload.lua');
  await mkdir(path.dirname(file), { recursive: true });
  const original = [
    'Other: disabled',
    ...[...DOWNLINK_HELPERS, ...UPLINK_HELPERS].map((name) => name + ': enabled'),
    'Tail: enabled',
  ].join('\r\n');
  await writeFile(file, original);
  const logs = captureLogs();
  const packets: Packet[] = [];
  const { bridge, close } = await openTransport(
    [
      root,
      (packet) => {
        packets.push(packet);
        receive(packet, bridge);
      },
    ],
    overrideFs,
    logs.layer,
  );
  const hello = { type: 'hello', session: 'v2', seq: 1, at: 1, transportVersion: 2 };
  return {
    root,
    bridge,
    start: () => Effect.runPromise(bridge.start()),
    file,
    payload,
    original,
    packets,
    get errors() {
      return logs.entries('transport.failed');
    },
    get heldOff() {
      return logs.entries('transport.heartbeat_held_off');
    },
    get slow() {
      return logs.entries('transport.downlink_');
    },
    hello,
    async send(packet: unknown, firstSequence = 0, compressed = false, target = file) {
      const raw = Buffer.from(JSON.stringify(packet));
      const frames = encodeMessage(
        compressed ? deflateSync(raw) : raw,
        UPLINK_KIND,
        77,
        firstSequence,
        compressed,
      );
      for (const frame of frames) {
        await writeFile(target, replaceUplink(await readFile(target, 'utf8'), frame));
        await Effect.runPromise(bridge.read(target, false).pipe(Effect.provide(logs.layer)));
      }
      return frames;
    },
    async close() {
      await close();
      expect(path.resolve(root).startsWith(base + path.sep)).toBeTruthy();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(read: () => Promise<T>, timeout = 2500) {
  // Tests mock Date.now; a frozen clock must not turn this into an endless wait.
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) {
      return result;
    }
    await delay(15);
  }
  throw Error('Timed out waiting for the transport');
}

test('fresh sparse AddOns.txt in a numeric realm connects and receives its first downlink', async () => {
  const f = await fixture(undefined, '91');
  try {
    await writeFile(f.file, 'Other: disabled\r\n');
    await Effect.runPromise(f.bridge.scan(true));
    const [frame] = encodeMessage(Buffer.from(JSON.stringify(f.hello)), UPLINK_KIND, 77);
    const sparse = [
      'Other: disabled',
      ...UPLINK_HELPERS.flatMap((name, index) =>
        frame.readUInt8(index >> 3) & (1 << (index % 8)) ? [] : [`${name}: disabled`],
      ),
    ].join('\r\n');
    await writeFile(f.file, sparse);
    await Effect.runPromise(f.bridge.read(f.file, false));
    expect(f.packets.length).toBe(1);
    expect(f.packets[0]?.type).toBe('hello');
    await Effect.runPromise(
      f.bridge.publish({ rev: 1, session: 'v2', connected: true, text: 'first connection' }),
    );
    const current = await readFile(f.file, 'utf8');
    expect(readUplink(current)).toStrictEqual(frame);
    expect(JSON.parse(decodeFrame(readDownlink(current)!)!.payload.toString())).toStrictEqual({
      r: 1,
    });
    expect(current.startsWith(sparse + '\r\n')).toBeTruthy();
    expect(await readFile(f.payload, 'utf8')).toContain('first connection');
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('initial scan baselines a cached hello and fresh hello retry preserves negotiation across session reset', async () => {
  const f = await fixture();
  try {
    const frames = encodeMessage(Buffer.from(JSON.stringify(f.hello)), UPLINK_KIND, 77);
    expect(frames.length, 'fixture must exercise the first already-published message').toBe(1);
    await writeFile(f.file, replaceUplink(f.original, frames[0]));
    await f.start();
    expect(f.packets.length, 'persisted hello cannot establish a stale session').toBe(0);
    await Effect.runPromise(f.bridge.read(f.file, false));
    expect(f.packets.length, 'an unchanged persisted frame stays suppressed').toBe(0);
    const [freshHello] = await f.send(f.hello, 10);
    expect(f.packets.length).toBe(1);
    expect(f.packets[0]?.transportVersion).toBe(2);
    await Effect.runPromise(f.bridge.publish({ rev: 2, session: 'v2', text: 'ready after reset' }));
    const current = await readFile(f.file, 'utf8');
    const ready = decodeFrame(readDownlink(current)!);
    expect(JSON.parse(ready!.payload.toString())).toStrictEqual({ r: 2 });
    expect(await readFile(f.payload, 'utf8')).toContain('ready after reset');
    expect(readUplink(current)).toStrictEqual(freshHello);
    expect(
      current.startsWith('Other: disabled\r\n') && current.endsWith('Tail: enabled'),
    ).toBeTruthy();
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('cached single-frame user operations are not replayed and fresh user data cannot negotiate v2 without hello', async () => {
  const f = await fixture();
  try {
    const say = {
      type: 'say',
      session: 'x',
      seq: 1,
      at: 1,
      chat: 'c',
      text: 'x',
      transportVersion: 2,
    };
    const [frame, ...rest] = encodeMessage(
      deflateSync(Buffer.from(JSON.stringify(say))),
      UPLINK_KIND,
      77,
      0,
      true,
    );
    expect(rest.length, 'fixture must be a complete single-frame user operation').toBe(0);
    await writeFile(f.file, replaceUplink(f.original, frame));
    await f.start();
    await Effect.runPromise(f.bridge.read(f.file, false));
    expect(f.packets.length).toBe(0);
    await f.send({ ...say, seq: 2 }, 10, true);
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'not negotiated' }));
    expect(f.packets.length).toBe(0);
    expect(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)).toBe(null);
    await f.send({ ...f.hello, session: 'x' }, 20);
    await f.send({ ...say, seq: 3 }, 30, true);
    expect(f.packets.map((packet) => packet.type)).toStrictEqual(['hello', 'say']);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('unversioned messages cannot negotiate or take ownership of an active Wisp session', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.send({ type: 'hello', session: 'unversioned', seq: 1, at: 1 });
    expect(f.packets.length).toBe(0);
    await f.send(f.hello, 10);
    await Effect.runPromise(f.bridge.publish({ rev: 2, text: 'v2 active' }));
    await f.send({ type: 'hello', session: 'unversioned', seq: 2, at: 2 }, 20);
    await f.send(
      { type: 'say', session: 'unversioned', seq: 3, at: 3, chat: 'c', text: 'must be ignored' },
      40,
    );
    expect(f.packets.map((packet) => packet.session)).toStrictEqual(['v2']);
    await f.send({ ...f.hello, type: 'say', seq: 2, at: 4, chat: 'c', text: 'still active' }, 60);
    expect(f.packets.at(-1)?.text).toBe('still active');
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('only fully decoded, CRC-valid, schema-valid v2 application messages reach dispatch', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.bridge.scan(true));
    await f.send(f.hello);
    const say = {
      ...f.hello,
      type: 'say',
      seq: 2,
      chat: 'chat',
      messageId: 'message',
      text: Array.from({ length: 80 }, (_, i) => 'text-' + i).join(' '),
    };
    const frames = encodeMessage(
      deflateSync(Buffer.from(JSON.stringify(say))),
      UPLINK_KIND,
      77,
      20,
      true,
    );
    expect(frames.length).toBeGreaterThan(2);
    for (const [index, encoded] of frames.entries()) {
      const frame = Buffer.from(encoded);
      if (index === 1) {
        frame.writeUInt8(frame.readUInt8(15) ^ 1, 15);
      }
      await writeFile(f.file, replaceUplink(await readFile(f.file, 'utf8'), frame));
      await Effect.runPromise(f.bridge.read(f.file, false));
    }
    expect(f.packets.length, 'damaged partial body cannot dispatch').toBe(1);
    await f.send(say, 100, true);
    expect(f.packets.length).toBe(2);
    expect(f.packets[1]?.text).toBe(say.text);
    await f.send({ ...say, seq: 3, text: '' }, 200);
    expect(f.packets.length, 'schema-invalid body cannot dispatch').toBe(2);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('readiness is reasserted after a game save loses it, then repair stops once acknowledged', async () => {
  const f = await fixture();
  try {
    await f.start();
    const [helloFrame] = await f.send(f.hello);
    await Effect.runPromise(f.bridge.publish({ rev: 8, text: 'bulk '.repeat(2000) }));
    expect(await readFile(f.payload, 'utf8')).toContain('bulk '.repeat(2000));
    const ready = readDownlink(await readFile(f.file, 'utf8'))!;
    const savedOldControl = replaceUplink(f.original, helloFrame);
    await writeFile(f.file, savedOldControl);
    await waitFor(async () => readDownlink(await readFile(f.file, 'utf8'))!.equals(ready));
    expect(f.packets.length, 'control repairs do not replay a game packet').toBe(1);
    await Effect.runPromise(f.bridge.setCursor(2, 8));
    await writeFile(f.file, savedOldControl);
    await delay(350);
    expect(await readFile(f.file, 'utf8')).toBe(savedOldControl);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('bulk publish is not announced until its file replacement succeeds', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.bridge.scan(true));
    await f.send(f.hello);
    // An occupied Interface path reliably fails before creating/replacing Payload.lua.
    const resolved = path.join(f.root, 'Interface');
    await writeFile(resolved, 'blocked');
    await expect(
      Effect.runPromise(f.bridge.publish({ rev: 4, text: 'must not announce' })),
    ).rejects.toThrow();
    expect(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)).toBe(null);
    await rm(resolved);
    await Effect.runPromise(f.bridge.publish({ rev: 4, text: 'must not announce' }));
    expect(
      JSON.parse(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!.payload.toString()),
    ).toStrictEqual({ r: 4 });
  } finally {
    await f.close();
  }
});

type TransportFixture = Awaited<ReturnType<typeof fixture>>;
let ackSequence = 1000;
async function mailbox(f: TransportFixture, bulkAvailable = false) {
  await f.start();
  await f.send({ ...f.hello, mailboxVersion: 1, bulkAvailable });
}
async function acknowledge(
  f: TransportFixture,
  frame: NonNullable<ReturnType<typeof decodeFrame>>,
  revision: number,
  bulkAvailable = false,
  resync = false,
) {
  if (frame.kind === COMPACT_DOWNLINK_KIND) {
    const current = await readFile(f.file, 'utf8');
    const lane = readUplink(current)!;
    encodeFrame({
      kind: COMPACT_ACK_KIND,
      flags: (resync ? 1 : 0) | (bulkAvailable ? 2 : 0),
      generation: frame.generation,
      sequence: frame.sequence,
      payload: Buffer.alloc(0),
    }).copy(lane);
    await writeFile(f.file, replaceUplink(current, lane));
    await Effect.runPromise(f.bridge.read(f.file, false));
    await Effect.runPromise(f.bridge.waitForWrites());
    return;
  }
  await f.send(
    {
      a: [frame.generation, frame.sequence, revision],
      b: bulkAvailable,
      ...(resync && { n: true }),
    },
    ackSequence++,
  );
  await Effect.runPromise(f.bridge.waitForWrites());
}
async function drainMailbox(
  f: TransportFixture,
  base?: unknown,
  kind: typeof DOWNLINK_KIND | typeof COMPACT_DOWNLINK_KIND = DOWNLINK_KIND,
) {
  const decoder = new MailboxDecoder(kind);
  let previous: Buffer | undefined;
  let count = 0;
  for (;;) {
    const { bytes, frame } = await waitFor(async () => {
      const bytes = readDownlink(await readFile(f.file, 'utf8'));
      if (bytes && !previous?.equals(bytes)) {
        const frame = decodeFrame(bytes);
        if (frame?.kind === kind && (frame.flags & COMPRESSED) !== 0) {
          return { bytes, frame };
        }
      }
      return undefined;
    });
    previous = bytes;
    const message = decoder.add(bytes);
    const envelope = message && JSON.parse(inflateMessage(message).toString('utf8'));
    const state = envelope && applyDownlink(envelope, base);
    await acknowledge(f, frame, Number(state?.rev ?? (base as { rev?: number })?.rev ?? 0));
    if (state) {
      return { state, envelope, frames: count + 1 };
    }
    expect(++count, 'a bounded message must eventually finish').toBeLessThan(2048);
  }
}

test('negotiated responses transfer through reusable fragments without any bulk directory', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const snapshot = { rev: 1, session: 'v2', text: 'Propio 🚀 '.repeat(50), ready: true };
    await Effect.runPromise(f.bridge.publish(snapshot));
    const result = await drainMailbox(f);
    expect(result.state).toStrictEqual(snapshot);
    expect(result.frames, 'exercise multi-frame flow control').toBeGreaterThan(1);
    await expect(readFile(f.payload)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.packets.length, 'transport ACKs are never application operations').toBe(1);
    expect(f.bridge.peerRevision).toBe(1);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('only matching ACKs advance a fragment, and lost file writes restore the same fragment', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'Checked responses '.repeat(40) }));
    const first = readDownlink(await readFile(f.file, 'utf8'))!;
    const frame = decodeFrame(first)!;
    await acknowledge(f, { ...frame, sequence: (frame.sequence + 1) & 65535 }, 0);
    await acknowledge(f, { ...frame, generation: frame.generation === 1 ? 2 : 1 }, 0);
    expect(readDownlink(await readFile(f.file, 'utf8'))).toStrictEqual(first);
    const uplink = readUplink(await readFile(f.file, 'utf8'))!;
    await writeFile(f.file, replaceUplink(f.original, uplink));
    await waitFor(async () => readDownlink(await readFile(f.file, 'utf8'))!.equals(first));
    await acknowledge(f, frame, 0);
    await waitFor(async () => !readDownlink(await readFile(f.file, 'utf8'))!.equals(first));
    const next = readDownlink(await readFile(f.file, 'utf8'))!;
    await acknowledge(f, frame, 0);
    expect(
      readDownlink(await readFile(f.file, 'utf8')),
      'late ACK cannot skip a fragment',
    ).toStrictEqual(next);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test(
  'an exhausted or failed last bulk load switches the same response to the reusable lane',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await mailbox(f, true);
      const text = Array.from({ length: 60 }, (_, i) => Math.sin(i * 123).toString(36)).join('');
      const snapshot = { rev: 1, text };
      await Effect.runPromise(f.bridge.publish(snapshot));
      const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
      expect(ready.flags, 'large state initially uses the optional file accelerator').toBe(3);
      expect(JSON.parse(ready.payload.toString())).toStrictEqual({ r: 1 });
      await Effect.runPromise(f.bridge.setCursor(1024, 0));
      await acknowledge(f, ready, 0, false);
      const result = await drainMailbox(f);
      expect(result.state).toStrictEqual(snapshot);
      expect(f.bridge.nextSlot).toBe(1024);
      // A stale envelope queued before exhaustion cannot turn bulk back on.
      await f.send({ ...f.hello, seq: 2, mailboxVersion: 1, bulkAvailable: true }, 3000);
      await Effect.runPromise(f.bridge.publish({ rev: 2, text: text + ' after the bank ran out' }));
      expect((await drainMailbox(f, snapshot)).state).toStrictEqual({
        rev: 2,
        text: text + ' after the bank ran out',
      });
      expect(f.errors).toStrictEqual([]);
    } finally {
      await f.close();
    }
  },
);

test(
  'bulk publication failure automatically falls back to data frames for a capable peer',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await mailbox(f, true);
      await writeFile(path.join(f.root, 'Interface'), 'bulk directory is inaccessible');
      const snapshot = {
        rev: 1,
        text: Array.from({ length: 80 }, (_, i) => Math.cos(i * 321).toString(36)).join(''),
      };
      await Effect.runPromise(f.bridge.publish(snapshot));
      expect((await drainMailbox(f)).state).toStrictEqual(snapshot);
      expect(f.errors).toStrictEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('publications coalesce without replacing unacknowledged data and patches use the exact acknowledged base', async () => {
  const f = await fixture();
  try {
    // The fixture explicitly reads each uplink. Keep the watcher and watchdog
    // out of this test so only the simulated peer drives acknowledgements.
    await f.send({ ...f.hello, mailboxVersion: 1, bulkAvailable: false });
    const first = {
      rev: 1,
      chats: [{ id: 'c', messages: [{ text: 'Unchanged '.repeat(500), ui: ['a', 'b'] }] }],
      catalog: Array.from({ length: 100 }, (_, i) => ({ id: 'model-' + i, name: 'Model ' + i })),
    };
    await Effect.runPromise(f.bridge.publish(first));
    const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
    const latest = {
      ...first,
      rev: 20,
      chats: [{ id: 'c', messages: [{ text: 'Final text', ui: ['a'] }] }],
    };
    for (let rev = 2; rev <= 20; rev++) {
      await Effect.runPromise(f.bridge.publish({ ...latest, rev }));
      expect(readDownlink(await readFile(f.file, 'utf8'))).toStrictEqual(bytes);
    }
    expect((await drainMailbox(f)).state).toStrictEqual(first);
    const final = await drainMailbox(f, first);
    expect(final.state).toStrictEqual(latest);
    expect(
      final.envelope.b,
      'delta must use the acknowledged state, not a skipped publication',
    ).toBe(1);
    expect(f.bridge.peerRevision).toBe(20);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('an oversized waiting view is reported once and the next valid view still arrives', async () => {
  const f = await fixture();
  try {
    await f.send({ ...f.hello, mailboxVersion: 1, bulkAvailable: false });
    const first = { rev: 1, text: 'first' };
    await Effect.runPromise(f.bridge.publish(first));
    await Effect.runPromise(f.bridge.publish({ rev: 2, text: 'x'.repeat(MAX_DECODED_BYTES) }));
    expect((await drainMailbox(f)).state).toStrictEqual(first);
    expect(f.errors).toEqual([{ error: 'Downlink state exceeds decoded limit' }]);

    const latest = { rev: 3, text: 'latest' };
    await Effect.runPromise(f.bridge.publish(latest));
    expect((await drainMailbox(f, first)).state).toStrictEqual(latest);
    expect(f.bridge.peerRevision).toBe(3);
    expect(f.errors).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('resynchronization discards a failed delta and delivers a fresh full latest snapshot', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const base = {
      rev: 1,
      catalog: Array.from({ length: 80 }, (_, i) => ({ id: 'model-' + i, name: 'Model ' + i })),
      text: 'before',
    };
    await Effect.runPromise(f.bridge.publish(base));
    await drainMailbox(f);
    const latest = { ...base, rev: 2, text: 'after' };
    await Effect.runPromise(f.bridge.publish(latest));
    const first = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    await acknowledge(f, first, 0, false, true);
    const full = await drainMailbox(f);
    expect(full.state).toStrictEqual(latest);
    expect(full.envelope.s && !('b' in full.envelope)).toBeTruthy();
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('unrelated B-lane state cannot negotiate or block a fresh mailbox hello and its response', async () => {
  const f = await fixture();
  try {
    await f.start();
    const unrelated = f.original.replace(
      /^WispAI_B(\d{3}):[^\r\n]*/gm,
      (_, id: string) => 'WispAI_B' + id + ': ' + (Number(id) % 3 ? 'disabled' : 'enabled'),
    );
    await writeFile(f.file, unrelated);
    await Effect.runPromise(f.bridge.read(f.file, false));
    expect(f.packets.length).toBe(0);
    await f.send({ ...f.hello, mailboxVersion: 1, bulkAvailable: false });
    const snapshot = { rev: 1, text: 'fresh after unrelated B state' };
    await Effect.runPromise(f.bridge.publish(snapshot));
    expect((await drainMailbox(f)).state).toStrictEqual(snapshot);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('host restarts discard old ACKs and unknown future cursors cannot suppress the new response', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'interrupted' }));
    const oldFrame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    await Effect.runPromise(f.bridge.resetSession());
    await Effect.runPromise(f.bridge.setCursor(1024, 9000));
    expect(f.bridge.peerRevision, 'previous-host revision cannot acknowledge unseen state').toBe(0);
    const snapshot = { rev: 2, text: 'fresh generation' };
    await Effect.runPromise(f.bridge.publish(snapshot));
    const fresh = readDownlink(await readFile(f.file, 'utf8'))!;
    await acknowledge(f, oldFrame, 1);
    expect(readDownlink(await readFile(f.file, 'utf8'))).toStrictEqual(fresh);
    await Effect.runPromise(f.bridge.setCursor(1024, 9000));
    expect(f.bridge.peerRevision).toBe(0);
    expect((await drainMailbox(f)).state).toStrictEqual(snapshot);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('bulk selection uses observed transfer costs and reserves scarce slots for larger savings', () => {
  expect(preferBulkDelivery(32, { fragmentMs: 500, bulkMs: 20, slotsRemaining: 1024 })).toBe(false);
  expect(preferBulkDelivery(160, { fragmentMs: 20, bulkMs: 120, slotsRemaining: 1024 })).toBe(
    false,
  );
  expect(preferBulkDelivery(160, { fragmentMs: 150, bulkMs: 120, slotsRemaining: 1024 })).toBe(
    true,
  );
  expect(preferBulkDelivery(512, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1024 })).toBe(true);
  expect(preferBulkDelivery(512, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1 })).toBe(false);
  expect(preferBulkDelivery(8192, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1 })).toBe(true);
  expect(preferBulkDelivery(8192, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 0 })).toBe(false);
});

test('compact-capable peers transfer checked state with header-only ACKs and no application dispatch', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: false });
    const snapshot = { rev: 1, session: 'v2', text: 'Compacto 🚀 '.repeat(100) };
    await Effect.runPromise(f.bridge.publish(snapshot));
    const frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    expect(frame.kind).toBe(COMPACT_DOWNLINK_KIND);
    const pending = readDownlink(await readFile(f.file, 'utf8'));
    await acknowledge(f, { ...frame, sequence: (frame.sequence + 1) & 65535 }, 0);
    await acknowledge(f, { ...frame, generation: frame.generation === 1 ? 2 : 1 }, 0);
    expect(readDownlink(await readFile(f.file, 'utf8'))).toStrictEqual(pending);
    expect((await drainMailbox(f, undefined, COMPACT_DOWNLINK_KIND)).state).toStrictEqual(snapshot);
    const ack = decodeFrame(readUplink(await readFile(f.file, 'utf8'))!.subarray(0, 16))!;
    expect(ack.kind).toBe(COMPACT_ACK_KIND);
    expect(ack.payload.length).toBe(0);
    expect(f.bridge.peerRevision).toBe(1);
    expect(f.packets.length).toBe(1);
    expect(f.bridge.performance.compactAcknowledgments).toBeGreaterThan(1);
    expect(f.bridge.performance.acknowledgments).toBe(f.bridge.performance.compactAcknowledgments);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('compact ACKs cannot negotiate support for an older peer', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const snapshot = { rev: 1, text: 'Raw ACK compatibility remains available' };
    await Effect.runPromise(f.bridge.publish(snapshot));
    const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
    const frame = decodeFrame(bytes)!;
    await acknowledge(f, { ...frame, kind: COMPACT_DOWNLINK_KIND }, 0);
    expect(readDownlink(await readFile(f.file, 'utf8'))).toStrictEqual(bytes);
    expect(f.bridge.performance.compactAcknowledgments).toBe(0);
    expect((await drainMailbox(f)).state).toStrictEqual(snapshot);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test(
  'compact bulk failures resynchronize the same state through compact reusable frames',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: true });
      const snapshot = {
        rev: 1,
        text: Array.from({ length: 120 }, (_, i) => Math.sin(i * 719).toString(36)).join(''),
      };
      await Effect.runPromise(f.bridge.publish(snapshot));
      const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
      expect(ready.kind).toBe(COMPACT_DOWNLINK_KIND);
      expect(ready.flags).toBe(3);
      expect(JSON.parse(ready.payload.toString())).toStrictEqual({ r: 1 });
      await acknowledge(f, ready, 0, false, true);
      expect((await drainMailbox(f, undefined, COMPACT_DOWNLINK_KIND)).state).toStrictEqual(
        snapshot,
      );
      expect(f.bridge.peerRevision).toBe(1);
      expect(f.bridge.performance.bulkStarts).toBe(1);
      expect(f.bridge.performance.mailboxStarts).toBe(1);
      expect(f.errors).toStrictEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('a file caught mid-rewrite is never replaced and its pending frame is restored afterwards', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: false });
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'x' }));
    const pending = readDownlink(await readFile(f.file, 'utf8'))!;
    // A writer truncated the file and has not written it yet. On Linux the
    // directory watcher reads it in exactly this state.
    await delay(200);
    await writeFile(f.file, '');
    await Effect.runPromise(f.bridge.read(f.file, false));
    await delay(200);
    expect(await readFile(f.file, 'utf8')).toBe('');
    await writeFile(f.file, f.original);
    await waitFor(async () => readDownlink(await readFile(f.file, 'utf8'))!.equals(pending));
    expect(await readFile(f.file, 'utf8')).toMatch(/^Other: disabled\r\n/);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('matching first-attempt ACKs update fragment RTT independently from bulk latency', async () => {
  const f = await fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await f.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: false });
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'x' }));
    let frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    expect(frame.flags & 2, 'exercise multiple latency samples').toBe(0);
    now.mockReturnValue(1060);
    await acknowledge(f, frame, 0);
    expect(f.bridge.performance.fragmentRttMs).toBe(60);
    frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    now.mockReturnValue(1140);
    await acknowledge(f, frame, 1);
    expect(f.bridge.performance.fragmentRttMs).toBe(64);
    expect(f.bridge.performance.bulkRttMs).toBe(undefined);
    expect(f.bridge.peerRevision).toBe(1);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
    now.mockRestore();
  }
});

test('a compact bulk confirmation updates both its latency and slot budget without another user message', async () => {
  const f = await fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await f.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: true });
    await Effect.runPromise(
      f.bridge.publish({
        rev: 1,
        text: Array.from({ length: 120 }, (_, i) => Math.cos(i * 419).toString(36)).join(''),
      }),
    );
    const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    expect(ready.flags).toBe(3);
    now.mockReturnValue(1120);
    await acknowledge(f, ready, 1, true);
    expect(f.bridge.performance.bulkRttMs).toBe(120);
    expect(f.bridge.performance.fragmentRttMs).toBe(undefined);
    expect(
      f.bridge.nextSlot,
      'the confirmed bulk read updates scarcity without an app cursor',
    ).toBe(2);
    expect(f.bridge.peerRevision).toBe(1);
    await Effect.runPromise(
      f.bridge.publish({
        rev: 2,
        text: Array.from({ length: 120 }, (_, i) => Math.cos(i * 293).toString(36)).join(''),
      }),
    );
    const second = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    expect(second.flags).toBe(3);
    // An application cursor may reach the host before the transport ACK.
    await Effect.runPromise(f.bridge.setCursor(3, 1));
    now.mockReturnValue(1240);
    await acknowledge(f, second, 2, true);
    expect(f.bridge.nextSlot, 'a newer app cursor must not be counted twice').toBe(3);
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
    now.mockRestore();
  }
});

test('another game window keeps the bridge until its heartbeat finds the first one quiet or its player asks', async () => {
  const f = await fixture();
  const other = path.join(path.dirname(path.dirname(f.file)), 'other/AddOns.txt');
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(other, f.original);
  let clock = 1_000_000;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const sessions = () => f.packets.map((packet) => packet.session + ':' + packet.type);
  try {
    await f.send(f.hello, 10);
    clock += 30_000;
    const heartbeat = { type: 'hello', seq: 1, transportVersion: 2, heartbeat: true };
    await f.send({ ...heartbeat, session: 'b', at: 2 }, 10, false, other);
    expect(sessions(), 'a heartbeat cannot take an active window').toStrictEqual(['v2:hello']);
    expect(f.heldOff).toHaveLength(1);

    // The active window still owns replies: its next message is delivered.
    await f.send({ type: 'poll', session: 'v2', seq: 2, at: 3, transportVersion: 2 }, 20);
    expect(sessions()).toStrictEqual(['v2:hello', 'v2:poll']);

    // The other window's player sent something that went unanswered.
    await f.send({ ...heartbeat, session: 'b', seq: 2, at: 4, takeover: true }, 20, false, other);
    expect(sessions().at(-1)).toStrictEqual('b:hello');
    await f.send({ ...heartbeat, session: 'v2', seq: 3, at: 5 }, 30);
    expect(sessions().at(-1), 'now the first window waits').toStrictEqual('b:hello');

    // Once the owner goes quiet, a heartbeat may take the bridge.
    clock += ACTIVE_SESSION_MS;
    await f.send({ ...heartbeat, session: 'v2', seq: 4, at: 6 }, 40);
    expect(sessions().at(-1)).toStrictEqual('v2:hello');
    expect(f.errors).toStrictEqual([]);
  } finally {
    now.mockRestore();
    await f.close();
  }
});

test('an active session rereads only its own state file between full folder walks', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true });
    expect(f.packets.length).toBe(1);
    const scan = vi.spyOn(f.bridge, 'scan');
    const read = vi.spyOn(f.bridge, 'read');
    await delay(1200);
    expect(scan.mock.calls.length, 'no full walk within the scan interval').toBe(0);
    expect(read.mock.calls.some(([file]) => file === f.file)).toBeTruthy();
    expect(f.errors).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('an abandoned control write removes its temporary copy', async () => {
  let reads = 0;
  let rewriting = false;
  // Make the game appear to rewrite the file between the bridge's two reads.
  const f = await fixture(undefined, undefined, (fs) => ({
    ...fs,
    readFileString: (file, encoding) =>
      fs
        .readFileString(file, encoding)
        .pipe(
          Effect.map((value) => (rewriting && ++reads === 2 ? value + '\r\nGame: enabled' : value)),
        ),
  }));
  try {
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true });
    rewriting = true;
    const before = await readFile(f.file, 'utf8');
    await Effect.runPromise(
      f.bridge.publish({ rev: 1, session: 'v2', connected: true, text: 'abandoned' }),
    );
    expect(reads, 'the write reached its second read').toBeGreaterThanOrEqual(2);
    await expect(readFile(f.file + '.wisp-control.tmp')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.file, 'utf8'), 'the changed file was not replaced').toBe(before);
  } finally {
    await f.close();
  }
});

test('a control rename retry does not overwrite an intervening game save', async () => {
  let target: string | undefined;
  let renameAttempts = 0;
  const savedByGame = 'WispAI: enabled\r\nGame: enabled\r\n';
  const f = await fixture(undefined, undefined, (fs) => ({
    ...fs,
    rename: (from, to) =>
      Effect.suspend(() => {
        if (to !== target || ++renameAttempts > 1) return fs.rename(from, to);
        return fs
          .writeFileString(to, savedByGame)
          .pipe(
            Effect.andThen(
              Effect.fail(systemError({ _tag: 'Busy', module: 'FileSystem', method: 'rename' })),
            ),
          );
      }),
  }));
  try {
    await f.send({ ...f.hello, mailboxVersion: 1 });
    target = f.file;
    await Effect.runPromise(f.bridge.publish({ rev: 1, text: 'reply' }));
    expect(renameAttempts).toBe(1);
    expect(await readFile(f.file, 'utf8')).toBe(savedByGame);
  } finally {
    await f.close();
  }
});

test('a reply the game has not read for 10 seconds is reported once, then again when it lands', async () => {
  const f = await fixture();
  // Jump the clock ahead but keep it running: the transport throttles control
  // rewrites by Date.now, so a frozen clock can leave a frame the test's own
  // ACK write reverted on disk forever when the runner is slow.
  const realNow = Date.now.bind(Date);
  let clock = 0;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock);
  try {
    await mailbox(f);
    const snapshot = { rev: 1, text: 'el huesoooo' };
    await Effect.runPromise(f.bridge.publish(snapshot));
    // The watchdog restarts an unacknowledged transfer every five seconds.
    clock += 6000;
    await delay(400);
    expect(f.slow.length, 'a single restart is not yet slow').toBe(0);
    clock += SLOW_DOWNLINK_MS;
    for (let i = 0; i < 40 && f.slow.length === 0; i++) await delay(50);
    clock += 6000;
    await delay(400);
    expect(f.slow.length, 'a stalled transfer is reported once').toBe(1);
    expect(f.slow[0]!.phase).toBe('stalled');
    expect(f.slow[0]!.revision).toBe(1);
    expect(f.slow[0]!.ageMs).toBeGreaterThanOrEqual(SLOW_DOWNLINK_MS);
    expect(f.slow[0]!.restarts).toBeGreaterThanOrEqual(2);
    expect((await drainMailbox(f)).state).toStrictEqual(snapshot);
    expect(f.slow.length).toBe(2);
    expect(f.slow[1]!.phase).toBe('delivered');
    expect(f.slow[1]!.ageMs).toBeGreaterThan(Number(f.slow[0]!.ageMs));
    // A prompt reply after that is not reported.
    await Effect.runPromise(f.bridge.publish({ rev: 2, text: 'rápido' }));
    await drainMailbox(f, snapshot);
    expect(f.slow.length).toBe(2);
    expect(f.errors).toStrictEqual([]);
  } finally {
    now.mockRestore();
    await f.close();
  }
});
