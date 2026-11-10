import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { DiskTransport, preferBulkDelivery } from '@wisp/bridge/transport';
import type { Packet } from '@wisp/protocol/protocol';
import {
  DOWNLINK_HELPERS,
  DOWNLINK_KIND,
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  COMPRESSED,
  MailboxDecoder,
  UPLINK_HELPERS,
  UPLINK_KIND,
  encodeMessage,
  encodeFrame,
  decodeFrame,
  readDownlink,
  readUplink,
  replaceUplink,
  inflateMessage,
} from '@wisp/protocol/mailbox';
import { applyDownlink } from '@wisp/protocol/downlink';

async function fixture(
  receive: (packet: Packet, bridge: DiskTransport) => void = () => {},
  realm = 'realm',
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
  const errors: unknown[] = [];
  const packets: Packet[] = [];
  const bridge = new DiskTransport(
    root,
    (packet) => {
      packets.push(packet);
      receive(packet, bridge);
    },
    (error) => errors.push(error),
  );
  const hello = { type: 'hello', session: 'v2', seq: 1, at: 1, transportVersion: 2 };
  return {
    root,
    bridge,
    file,
    payload,
    original,
    packets,
    errors,
    hello,
    async send(packet: unknown, firstSequence = 0, compressed = false) {
      const raw = Buffer.from(JSON.stringify(packet));
      const frames = encodeMessage(
        compressed ? deflateSync(raw) : raw,
        UPLINK_KIND,
        77,
        firstSequence,
        compressed,
      );
      for (const frame of frames) {
        await writeFile(file, replaceUplink(await readFile(file, 'utf8'), frame));
        await bridge.read(file, false);
      }
      return frames;
    },
    async close() {
      bridge.stop();
      await bridge.writing.catch(() => {});
      assert.ok(path.resolve(root).startsWith(base + path.sep));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(15);
  }
  assert.fail('Timed out waiting for the transport');
}

test('fresh sparse AddOns.txt in a numeric realm connects and receives its first downlink', async () => {
  const f = await fixture(undefined, '91');
  try {
    await writeFile(f.file, 'Other: disabled\r\n');
    await f.bridge.scan(true);
    const [frame] = encodeMessage(Buffer.from(JSON.stringify(f.hello)), UPLINK_KIND, 77);
    const sparse = [
      'Other: disabled',
      ...UPLINK_HELPERS.flatMap((name, index) =>
        frame[index >> 3] & (1 << (index % 8)) ? [] : [`${name}: disabled`],
      ),
    ].join('\r\n');
    await writeFile(f.file, sparse);
    await f.bridge.read(f.file, false);
    assert.equal(f.packets.length, 1);
    assert.equal(f.packets[0].type, 'hello');
    await f.bridge.publish({ rev: 1, session: 'v2', connected: true, text: 'first connection' });
    const current = await readFile(f.file, 'utf8');
    assert.deepEqual(readUplink(current), frame);
    assert.deepEqual(JSON.parse(decodeFrame(readDownlink(current)!)!.payload.toString()), { r: 1 });
    assert.ok(current.startsWith(sparse + '\r\n'));
    assert.ok((await readFile(f.payload, 'utf8')).includes('first connection'));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('initial scan baselines a cached hello and fresh hello retry preserves negotiation across session reset', async () => {
  const f = await fixture((packet, bridge) => {
    if (packet.type === 'hello') {
      bridge.resetSession();
    }
  });
  try {
    const frames = encodeMessage(Buffer.from(JSON.stringify(f.hello)), UPLINK_KIND, 77);
    assert.equal(frames.length, 1, 'fixture must exercise the first already-published message');
    await writeFile(f.file, replaceUplink(f.original, frames[0]));
    await f.bridge.start();
    assert.equal(f.packets.length, 0, 'persisted hello cannot establish a stale session');
    await f.bridge.read(f.file, false);
    assert.equal(f.packets.length, 0, 'an unchanged persisted frame stays suppressed');
    const [freshHello] = await f.send(f.hello, 10);
    assert.equal(f.packets.length, 1);
    assert.equal(f.packets[0].transportVersion, 2);
    await f.bridge.publish({ rev: 2, session: 'v2', text: 'ready after reset' });
    const current = await readFile(f.file, 'utf8');
    const ready = decodeFrame(readDownlink(current)!);
    assert.deepEqual(JSON.parse(ready!.payload.toString()), { r: 2 });
    assert.ok((await readFile(f.payload, 'utf8')).includes('ready after reset'));
    assert.deepEqual(readUplink(current), freshHello);
    assert.ok(current.startsWith('Other: disabled\r\n') && current.endsWith('Tail: enabled'));
    assert.deepEqual(f.errors, []);
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
    assert.equal(rest.length, 0, 'fixture must be a complete single-frame user operation');
    await writeFile(f.file, replaceUplink(f.original, frame));
    await f.bridge.start();
    await f.bridge.read(f.file, false);
    assert.equal(f.packets.length, 0);
    await f.send({ ...say, seq: 2 }, 10, true);
    await f.bridge.publish({ rev: 1, text: 'not negotiated' });
    assert.equal(f.packets.length, 0);
    assert.equal(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!), null);
    await f.send({ ...f.hello, session: 'x' }, 20);
    await f.send({ ...say, seq: 3 }, 30, true);
    assert.deepEqual(
      f.packets.map((packet) => packet.type),
      ['hello', 'say'],
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('unversioned messages cannot negotiate or take ownership of an active Wisp session', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    await f.send({ type: 'hello', session: 'unversioned', seq: 1, at: 1 });
    assert.equal(f.packets.length, 0);
    await f.send(f.hello, 10);
    await f.bridge.publish({ rev: 2, text: 'v2 active' });
    await f.send({ type: 'hello', session: 'unversioned', seq: 2, at: 2 }, 20);
    await f.send(
      { type: 'say', session: 'unversioned', seq: 3, at: 3, chat: 'c', text: 'must be ignored' },
      40,
    );
    assert.deepEqual(
      f.packets.map((packet) => packet.session),
      ['v2'],
    );
    await f.send({ ...f.hello, type: 'say', seq: 2, at: 4, chat: 'c', text: 'still active' }, 60);
    assert.equal(f.packets.at(-1)?.text, 'still active');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('only fully decoded, CRC-valid, schema-valid v2 application messages reach dispatch', async () => {
  const f = await fixture();
  try {
    await f.bridge.scan(true);
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
    assert.ok(frames.length > 2);
    for (let index = 0; index < frames.length; index++) {
      const frame = Buffer.from(frames[index]);
      if (index === 1) {
        frame[15] ^= 1;
      }
      await writeFile(f.file, replaceUplink(await readFile(f.file, 'utf8'), frame));
      await f.bridge.read(f.file, false);
    }
    assert.equal(f.packets.length, 1, 'damaged partial body cannot dispatch');
    await f.send(say, 100, true);
    assert.equal(f.packets.length, 2);
    assert.equal(f.packets[1].text, say.text);
    await f.send({ ...say, seq: 3, text: '' }, 200);
    assert.equal(f.packets.length, 2, 'schema-invalid body cannot dispatch');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('readiness is reasserted after a game save loses it, then repair stops once acknowledged', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    const [helloFrame] = await f.send(f.hello);
    await f.bridge.publish({ rev: 8, text: 'bulk '.repeat(2000) });
    assert.ok((await readFile(f.payload, 'utf8')).includes('bulk '.repeat(2000)));
    const ready = readDownlink(await readFile(f.file, 'utf8'))!;
    const savedOldControl = replaceUplink(f.original, helloFrame);
    await writeFile(f.file, savedOldControl);
    await waitFor(async () => readDownlink(await readFile(f.file, 'utf8'))!.equals(ready));
    assert.equal(f.packets.length, 1, 'control repairs do not replay a game packet');
    f.bridge.setCursor(2, 8);
    await writeFile(f.file, savedOldControl);
    await delay(350);
    assert.equal(await readFile(f.file, 'utf8'), savedOldControl);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('bulk publish is not announced until its file replacement succeeds', async () => {
  const f = await fixture();
  try {
    await f.bridge.scan(true);
    await f.send(f.hello);
    // An occupied Interface path reliably fails before creating/replacing Payload.lua.
    const resolved = path.join(f.root, 'Interface');
    await writeFile(resolved, 'blocked');
    await assert.rejects(f.bridge.publish({ rev: 4, text: 'must not announce' }));
    assert.equal(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!), null);
    await rm(resolved);
    await f.bridge.publish({ rev: 4, text: 'must not announce' });
    assert.deepEqual(
      JSON.parse(decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!.payload.toString()),
      { r: 4 },
    );
  } finally {
    await f.close();
  }
});

type TransportFixture = Awaited<ReturnType<typeof fixture>>;
let ackSequence = 1000;
async function mailbox(f: TransportFixture, bulkAvailable = false) {
  await f.bridge.start();
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
    await f.bridge.read(f.file, false);
    await f.bridge.writing;
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
  await f.bridge.writing;
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
    await waitFor(async () => {
      const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
      return (
        Boolean((decodeFrame(bytes)?.flags ?? 0) & COMPRESSED) &&
        !bytes.equals(previous ?? Buffer.alloc(0))
      );
    });
    const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
    const frame = decodeFrame(bytes)!;
    previous = bytes;
    const message = decoder.add(bytes);
    const envelope = message && JSON.parse(inflateMessage(message).toString('utf8'));
    const state = envelope && applyDownlink(envelope, base);
    await acknowledge(f, frame, Number(state?.rev ?? (base as { rev?: number })?.rev ?? 0));
    if (state) {
      return { state, envelope, frames: count + 1 };
    }
    assert.ok(++count < 2048, 'a bounded message must eventually finish');
  }
}

test('negotiated responses transfer through reusable fragments without any bulk directory', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const snapshot = { rev: 1, session: 'v2', text: 'Propio 🚀 '.repeat(50), ready: true };
    await f.bridge.publish(snapshot);
    const result = await drainMailbox(f);
    assert.deepEqual(result.state, snapshot);
    assert.ok(result.frames > 1, 'exercise multi-frame flow control');
    await assert.rejects(readFile(f.payload), { code: 'ENOENT' });
    assert.equal(f.packets.length, 1, 'transport ACKs are never application operations');
    assert.equal(f.bridge.peerRevision, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('only matching ACKs advance a fragment, and lost file writes restore the same fragment', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    await f.bridge.publish({ rev: 1, text: 'Checked responses '.repeat(40) });
    const first = readDownlink(await readFile(f.file, 'utf8'))!;
    const frame = decodeFrame(first)!;
    await acknowledge(f, { ...frame, sequence: (frame.sequence + 1) & 65535 }, 0);
    await acknowledge(f, { ...frame, generation: frame.generation === 1 ? 2 : 1 }, 0);
    assert.deepEqual(readDownlink(await readFile(f.file, 'utf8')), first);
    const uplink = readUplink(await readFile(f.file, 'utf8'))!;
    await writeFile(f.file, replaceUplink(f.original, uplink));
    await waitFor(async () => readDownlink(await readFile(f.file, 'utf8'))!.equals(first));
    await acknowledge(f, frame, 0);
    await waitFor(async () => !readDownlink(await readFile(f.file, 'utf8'))!.equals(first));
    const next = readDownlink(await readFile(f.file, 'utf8'))!;
    await acknowledge(f, frame, 0);
    assert.deepEqual(
      readDownlink(await readFile(f.file, 'utf8')),
      next,
      'late ACK cannot skip a fragment',
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('an exhausted or failed last bulk load switches the same response to the reusable lane', async () => {
  const f = await fixture();
  try {
    await mailbox(f, true);
    const text = Array.from({ length: 60 }, (_, i) => Math.sin(i * 123).toString(36)).join('');
    const snapshot = { rev: 1, text };
    await f.bridge.publish(snapshot);
    const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(ready.flags, 3, 'large state initially uses the optional file accelerator');
    assert.deepEqual(JSON.parse(ready.payload.toString()), { r: 1 });
    f.bridge.setCursor(1024, 0);
    await acknowledge(f, ready, 0, false);
    const result = await drainMailbox(f);
    assert.deepEqual(result.state, snapshot);
    assert.equal(f.bridge.nextSlot, 1024);
    // A stale envelope queued before exhaustion cannot turn bulk back on.
    await f.send({ ...f.hello, seq: 2, mailboxVersion: 1, bulkAvailable: true }, 3000);
    await f.bridge.publish({ rev: 2, text: text + ' after the bank ran out' });
    assert.deepEqual((await drainMailbox(f, snapshot)).state, {
      rev: 2,
      text: text + ' after the bank ran out',
    });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('bulk publication failure automatically falls back to data frames for a capable peer', async () => {
  const f = await fixture();
  try {
    await mailbox(f, true);
    await writeFile(path.join(f.root, 'Interface'), 'bulk directory is inaccessible');
    const snapshot = {
      rev: 1,
      text: Array.from({ length: 80 }, (_, i) => Math.cos(i * 321).toString(36)).join(''),
    };
    await f.bridge.publish(snapshot);
    assert.deepEqual((await drainMailbox(f)).state, snapshot);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('publications coalesce without replacing unacknowledged data and patches use the exact acknowledged base', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const first = {
      rev: 1,
      chats: [{ id: 'c', messages: [{ text: 'Unchanged '.repeat(500), ui: ['a', 'b'] }] }],
      catalog: Array.from({ length: 100 }, (_, i) => ({ id: 'model-' + i, name: 'Model ' + i })),
    };
    await f.bridge.publish(first);
    const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
    const latest = {
      ...first,
      rev: 20,
      chats: [{ id: 'c', messages: [{ text: 'Final text', ui: ['a'] }] }],
    };
    for (let rev = 2; rev <= 20; rev++) {
      await f.bridge.publish({ ...latest, rev });
      assert.deepEqual(readDownlink(await readFile(f.file, 'utf8')), bytes);
    }
    assert.deepEqual((await drainMailbox(f)).state, first);
    const final = await drainMailbox(f, first);
    assert.deepEqual(final.state, latest);
    assert.equal(
      final.envelope.b,
      1,
      'delta must use the acknowledged state, not a skipped publication',
    );
    assert.equal(f.bridge.peerRevision, 20);
    assert.deepEqual(f.errors, []);
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
    await f.bridge.publish(base);
    await drainMailbox(f);
    const latest = { ...base, rev: 2, text: 'after' };
    await f.bridge.publish(latest);
    const first = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    await acknowledge(f, first, 0, false, true);
    const full = await drainMailbox(f);
    assert.deepEqual(full.state, latest);
    assert.ok(full.envelope.s && !('b' in full.envelope));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('unrelated B-lane state cannot negotiate or block a fresh mailbox hello and its response', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    const unrelated = f.original.replace(
      /^WispAI_B(\d{3}):[^\r\n]*/gm,
      (_, id: string) => 'WispAI_B' + id + ': ' + (Number(id) % 3 ? 'disabled' : 'enabled'),
    );
    await writeFile(f.file, unrelated);
    await f.bridge.read(f.file, false);
    assert.equal(f.packets.length, 0);
    await f.send({ ...f.hello, mailboxVersion: 1, bulkAvailable: false });
    const snapshot = { rev: 1, text: 'fresh after unrelated B state' };
    await f.bridge.publish(snapshot);
    assert.deepEqual((await drainMailbox(f)).state, snapshot);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('host restarts discard old ACKs and unknown future cursors cannot suppress the new response', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    await f.bridge.publish({ rev: 1, text: 'interrupted' });
    const oldFrame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    f.bridge.resetSession();
    f.bridge.setCursor(1024, 9000);
    assert.equal(
      f.bridge.peerRevision,
      0,
      'previous-host revision cannot acknowledge unseen state',
    );
    const snapshot = { rev: 2, text: 'fresh generation' };
    await f.bridge.publish(snapshot);
    const fresh = readDownlink(await readFile(f.file, 'utf8'))!;
    await acknowledge(f, oldFrame, 1);
    assert.deepEqual(readDownlink(await readFile(f.file, 'utf8')), fresh);
    f.bridge.setCursor(1024, 9000);
    assert.equal(f.bridge.peerRevision, 0);
    assert.deepEqual((await drainMailbox(f)).state, snapshot);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('bulk selection uses observed transfer costs and reserves scarce slots for larger savings', () => {
  assert.equal(
    preferBulkDelivery(32, { fragmentMs: 500, bulkMs: 20, slotsRemaining: 1024 }),
    false,
  );
  assert.equal(
    preferBulkDelivery(160, { fragmentMs: 20, bulkMs: 120, slotsRemaining: 1024 }),
    false,
  );
  assert.equal(
    preferBulkDelivery(160, { fragmentMs: 150, bulkMs: 120, slotsRemaining: 1024 }),
    true,
  );
  assert.equal(
    preferBulkDelivery(512, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1024 }),
    true,
  );
  assert.equal(preferBulkDelivery(512, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1 }), false);
  assert.equal(preferBulkDelivery(8192, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 1 }), true);
  assert.equal(preferBulkDelivery(8192, { fragmentMs: 50, bulkMs: 150, slotsRemaining: 0 }), false);
});

test('compact-capable peers transfer checked state with header-only ACKs and no application dispatch', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: false });
    const snapshot = { rev: 1, session: 'v2', text: 'Compacto 🚀 '.repeat(100) };
    await f.bridge.publish(snapshot);
    const frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(frame.kind, COMPACT_DOWNLINK_KIND);
    const pending = readDownlink(await readFile(f.file, 'utf8'));
    await acknowledge(f, { ...frame, sequence: (frame.sequence + 1) & 65535 }, 0);
    await acknowledge(f, { ...frame, generation: frame.generation === 1 ? 2 : 1 }, 0);
    assert.deepEqual(readDownlink(await readFile(f.file, 'utf8')), pending);
    assert.deepEqual((await drainMailbox(f, undefined, COMPACT_DOWNLINK_KIND)).state, snapshot);
    const ack = decodeFrame(readUplink(await readFile(f.file, 'utf8'))!.subarray(0, 16))!;
    assert.equal(ack.kind, COMPACT_ACK_KIND);
    assert.equal(ack.payload.length, 0);
    assert.equal(f.bridge.peerRevision, 1);
    assert.equal(f.packets.length, 1);
    assert.ok(f.bridge.performance.compactAcknowledgments > 1);
    assert.equal(f.bridge.performance.acknowledgments, f.bridge.performance.compactAcknowledgments);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('compact ACKs cannot negotiate support for an older peer', async () => {
  const f = await fixture();
  try {
    await mailbox(f);
    const snapshot = { rev: 1, text: 'Raw ACK compatibility remains available' };
    await f.bridge.publish(snapshot);
    const bytes = readDownlink(await readFile(f.file, 'utf8'))!;
    const frame = decodeFrame(bytes)!;
    await acknowledge(f, { ...frame, kind: COMPACT_DOWNLINK_KIND }, 0);
    assert.deepEqual(readDownlink(await readFile(f.file, 'utf8')), bytes);
    assert.equal(f.bridge.performance.compactAcknowledgments, 0);
    assert.deepEqual((await drainMailbox(f)).state, snapshot);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('compact bulk failures resynchronize the same state through compact reusable frames', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: true });
    const snapshot = {
      rev: 1,
      text: Array.from({ length: 120 }, (_, i) => Math.sin(i * 719).toString(36)).join(''),
    };
    await f.bridge.publish(snapshot);
    const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(ready.kind, COMPACT_DOWNLINK_KIND);
    assert.equal(ready.flags, 3);
    assert.deepEqual(JSON.parse(ready.payload.toString()), { r: 1 });
    await acknowledge(f, ready, 0, false, true);
    assert.deepEqual((await drainMailbox(f, undefined, COMPACT_DOWNLINK_KIND)).state, snapshot);
    assert.equal(f.bridge.peerRevision, 1);
    assert.equal(f.bridge.performance.bulkStarts, 1);
    assert.equal(f.bridge.performance.mailboxStarts, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('matching first-attempt ACKs update fragment RTT independently from bulk latency', async () => {
  const f = await fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await f.bridge.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: false });
    await f.bridge.publish({ rev: 1, text: 'x' });
    let frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(frame.flags & 2, 0, 'exercise multiple latency samples');
    now.mockReturnValue(1060);
    await acknowledge(f, frame, 0);
    assert.equal(f.bridge.performance.fragmentRttMs, 60);
    frame = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    now.mockReturnValue(1140);
    await acknowledge(f, frame, 1);
    assert.equal(f.bridge.performance.fragmentRttMs, 64);
    assert.equal(f.bridge.performance.bulkRttMs, undefined);
    assert.equal(f.bridge.peerRevision, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    now.mockRestore();
  }
});

test('a compact bulk confirmation updates both its latency and slot budget without another user message', async () => {
  const f = await fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await f.bridge.start();
    await f.send({ ...f.hello, mailboxVersion: 1, compactAck: true, bulkAvailable: true });
    await f.bridge.publish({
      rev: 1,
      text: Array.from({ length: 120 }, (_, i) => Math.cos(i * 419).toString(36)).join(''),
    });
    const ready = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(ready.flags, 3);
    now.mockReturnValue(1120);
    await acknowledge(f, ready, 1, true);
    assert.equal(f.bridge.performance.bulkRttMs, 120);
    assert.equal(f.bridge.performance.fragmentRttMs, undefined);
    assert.equal(
      f.bridge.nextSlot,
      2,
      'the confirmed bulk read updates scarcity without an app cursor',
    );
    assert.equal(f.bridge.peerRevision, 1);
    await f.bridge.publish({
      rev: 2,
      text: Array.from({ length: 120 }, (_, i) => Math.cos(i * 293).toString(36)).join(''),
    });
    const second = decodeFrame(readDownlink(await readFile(f.file, 'utf8'))!)!;
    assert.equal(second.flags, 3);
    // An application cursor may reach the host before the transport ACK.
    f.bridge.nextSlot = 3;
    now.mockReturnValue(1240);
    await acknowledge(f, second, 2, true);
    assert.equal(f.bridge.nextSlot, 3, 'a newer app cursor must not be counted twice');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    now.mockRestore();
  }
});
