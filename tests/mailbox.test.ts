import { test, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import {
  FIRST,
  LAST,
  COMPRESSED,
  UPLINK_KIND,
  DOWNLINK_KIND,
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  UPLINK_HELPERS,
  DOWNLINK_HELPERS,
  MAX_ENCODED_BYTES,
  MAX_DECODED_BYTES,
  encodeFrame,
  decodeFrame,
  encodeMessage,
  readUplink,
  readDownlink,
  replaceDownlink,
  MailboxDecoder,
  inflateMessage,
} from '../packages/protocol/src/mailbox.ts';

test('negotiated compact ACKs are checked 16-byte control frames and never message fragments', () => {
  for (const flags of [0, 1, 2, 3]) {
    const frame = encodeFrame({
      kind: COMPACT_ACK_KIND,
      generation: 19,
      sequence: 65535,
      flags,
      payload: Buffer.alloc(0),
    });
    expect(frame.length).toBe(16);
    expect(decodeFrame(frame)).toMatchObject({
      kind: COMPACT_ACK_KIND,
      generation: 19,
      sequence: 65535,
      flags,
      payload: Buffer.alloc(0),
    });
    const damaged = Buffer.from(frame);
    damaged[4] ^= 1;
    expect(decodeFrame(damaged)).toBeNull();
  }
  expect(() =>
    encodeFrame({
      kind: COMPACT_ACK_KIND,
      generation: 1,
      sequence: 0,
      flags: 4,
      payload: Buffer.alloc(0),
    }),
  ).toThrow();
  expect(() =>
    encodeFrame({
      kind: COMPACT_ACK_KIND,
      generation: 1,
      sequence: 0,
      flags: 0,
      payload: Buffer.from('x'),
    }),
  ).toThrow();
  expect(() => encodeMessage(Buffer.alloc(0), COMPACT_ACK_KIND, 1)).toThrow();
  expect(() => new MailboxDecoder(COMPACT_ACK_KIND)).toThrow();
});

test('compact downlink negotiation retains full CRC-protected message reassembly and sequence wrap', () => {
  const body = Buffer.from('response '.repeat(80));
  const frames = encodeMessage(body, COMPACT_DOWNLINK_KIND, 81, 65535);
  const decoder = new MailboxDecoder(COMPACT_DOWNLINK_KIND);
  let received;
  for (const frame of frames) {
    expect(frame.length).toBe(48);
    received = decoder.add(frame) || received;
  }
  expect(received?.body).toEqual(body);
  expect(new MailboxDecoder(DOWNLINK_KIND).add(frames[0])).toBeNull();
});

function stateFile() {
  return [
    'Other: disabled',
    ...Array.from({ length: 128 }, (_, i) => `WispAI_B${String(i + 1).padStart(3, '0')}: enabled`),
    ...Array.from({ length: 1024 }, (_, i) => `WispAI_S${String(i + 1).padStart(4, '0')}: enabled`),
    'Tail: enabled',
  ].join('\r\n');
}

test('own v2 frame has stable byte layout and rejects corrupt, malformed and wrong-lane frames', () => {
  const frame = encodeFrame({
    kind: UPLINK_KIND,
    generation: 0xfedcba98,
    sequence: 65535,
    flags: FIRST | LAST,
    payload: Buffer.from('¿Qué hago? ❄'),
  });
  expect(frame.length).toBe(96);
  expect(frame.subarray(0, 12).toString('hex')).toBe('57320103fedcba98ffff0010');
  expect(frame.readUInt32BE(92)).toBe(crc32(frame.subarray(0, 92)));
  expect(decodeFrame(frame)).toMatchObject({ generation: 0xfedcba98, sequence: 65535 });
  for (const index of [0, 2, 3, 4, 8, 10, 12, 91, 95]) {
    const corrupt = Buffer.from(frame);
    corrupt[index] ^= 1;
    expect(decodeFrame(corrupt)).toBeNull();
  }
  const padding = Buffer.from(frame);
  padding[91] = 7;
  padding.writeUInt32BE(crc32(padding.subarray(0, 92)), 92);
  expect(decodeFrame(padding)).toBeNull();
  expect(decodeFrame(frame.subarray(0, 48))).toBeNull();
  expect(new MailboxDecoder(DOWNLINK_KIND).add(frame)).toBeNull();
  expect(() =>
    encodeFrame({
      kind: DOWNLINK_KIND,
      generation: 1,
      sequence: 0,
      flags: FIRST,
      payload: Buffer.alloc(33),
    }),
  ).toThrow();
});

test('lane publication preserves the uplink and unrelated CRLF settings, validates every owned bit', () => {
  const original = stateFile();
  const frame = encodeFrame({
    kind: DOWNLINK_KIND,
    generation: 31,
    sequence: 17,
    flags: FIRST | LAST,
    payload: Buffer.from('native response'),
  });
  const updated = replaceDownlink(original, frame);
  expect(readDownlink(updated)).toEqual(frame);
  expect(readUplink(updated)).toEqual(Buffer.alloc(96, 255));
  expect(updated.startsWith('Other: disabled\r\n')).toBe(true);
  expect(updated.endsWith('Tail: enabled')).toBe(true);
  expect(DOWNLINK_HELPERS[0]).toBe('WispAI_B001');
  expect(DOWNLINK_HELPERS[128]).toBe('WispAI_S0001');
  expect(DOWNLINK_HELPERS.at(-1)).toBe('WispAI_S0256');
  expect(UPLINK_HELPERS[0]).toBe('WispAI_S0257');
  expect(UPLINK_HELPERS.at(-1)).toBe('WispAI_S1024');
  expect(readDownlink(updated + '\r\nWispAI_B001: disabled')).toBeNull();
  expect(readUplink(updated + '\r\nWispAI_S0257: nonsense')).toBeNull();
  expect(readUplink(updated.replace('WispAI_S1024: enabled', ''))).toEqual(readUplink(updated));
  expect(() => replaceDownlink(updated + '\r\nWispAI_B001: invalid', frame)).toThrow();
  expect(
    readDownlink(replaceDownlink(updated.replace(/^WispAI_B001:[^\r\n]*/m, ''), frame)),
  ).toEqual(frame);
});

test('omitted enabled helpers decode a valid uplink and missing downlink lines are created', () => {
  const frame = encodeMessage(Buffer.from('fresh hello'), UPLINK_KIND, 7)[0];
  // WoW may persist only explicit overrides; omitted helpers default to enabled.
  const sparse = [
    'Other: disabled',
    ...UPLINK_HELPERS.flatMap((name, index) =>
      frame[index >> 3] & (1 << (index % 8)) ? [] : [`${name}: disabled`],
    ),
    'Tail: enabled',
  ].join('\r\n');
  expect(readUplink(sparse)).toEqual(frame);
  expect(decodeFrame(readUplink(sparse)!)).toMatchObject({ generation: 7 });
  expect(readUplink('')).toEqual(Buffer.alloc(96, 255));
  expect(decodeFrame(readUplink('')!)).toBeNull();
  const response = encodeMessage(Buffer.from('ready'), DOWNLINK_KIND, 9)[0];
  for (const text of [sparse, sparse + '\r\n', '', 'Other: disabled\n']) {
    const updated = replaceDownlink(text, response);
    expect(updated.startsWith(text)).toBe(true);
    expect(readDownlink(updated)).toEqual(response);
    expect(readUplink(updated)).toEqual(readUplink(text));
    expect(replaceDownlink(updated, response)).toBe(updated);
  }
});

test('multilingual compression survives frame duplication and uint16 sequence wrap', () => {
  const original = Buffer.from(
    JSON.stringify({ text: '¿Qué hago ahora? Frost Nova ❄'.repeat(200), seq: 7 }),
  );
  const frames = encodeMessage(deflateSync(original), UPLINK_KIND, 0xfedcba98, 65535, true);
  expect(frames.length).toBeGreaterThan(1);
  expect(decodeFrame(frames[1])?.sequence).toBe(0);
  const decoder = new MailboxDecoder(UPLINK_KIND);
  let result;
  for (const frame of frames) {
    result = decoder.add(frame) || result;
    expect(decoder.add(frame)).toBeNull();
  }
  expect(result?.flags).toBe(COMPRESSED);
  expect(inflateMessage(result!)).toEqual(original);
});

test('gaps never deliver a partial message, retry FIRST recovers, stale generations cannot interrupt a new one', () => {
  const body = Buffer.from('x'.repeat(250));
  const frames = encodeMessage(body, UPLINK_KIND, 11, 0);
  const decoder = new MailboxDecoder(UPLINK_KIND);
  for (const frame of frames.filter((_, index) => index !== 1)) {
    expect(decoder.add(frame)).toBeNull();
  }
  const retry = encodeMessage(body, UPLINK_KIND, 11, 20);
  let result;
  for (const frame of retry) {
    result = decoder.add(frame) || result;
  }
  expect(result?.body).toEqual(body);
  const next = encodeMessage(body, UPLINK_KIND, 12, 0);
  expect(decoder.add(next[0])).toBeNull();
  expect(decoder.add(retry[0])).toBeNull();
  for (const frame of next.slice(1)) {
    result = decoder.add(frame) || result;
  }
  expect(result?.generation).toBe(12);
  expect(result?.body).toEqual(body);
});

test('a stale startup baseline is ignored and restart requires a fresh FIRST', () => {
  const frames = encodeMessage(Buffer.from('a'.repeat(250)), UPLINK_KIND, 1, 0);
  const decoder = new MailboxDecoder(UPLINK_KIND);
  decoder.baseline(frames[0]);
  for (const frame of frames) {
    expect(decoder.add(frame)).toBeNull();
  }
  const fresh = encodeMessage(Buffer.from('new session'), UPLINK_KIND, 2, 0);
  expect(decoder.add(fresh[0])?.body.toString()).toBe('new session');
  decoder.reset();
  expect(decoder.add(frames.at(-1)!)).toBeNull();
});

test('encoded and decompressed bounds prevent unbounded buffering and zlib expansion', () => {
  expect(() => encodeMessage(Buffer.alloc(MAX_ENCODED_BYTES + 1), UPLINK_KIND, 1)).toThrow();
  const decoder = new MailboxDecoder(UPLINK_KIND);
  for (let sequence = 0; sequence < 900; sequence++) {
    expect(
      decoder.add(
        encodeFrame({
          kind: UPLINK_KIND,
          generation: 1,
          sequence,
          flags: sequence === 0 ? FIRST : 0,
          payload: Buffer.alloc(80),
        }),
      ),
    ).toBeNull();
  }
  expect(
    decoder.add(
      encodeFrame({
        kind: UPLINK_KIND,
        generation: 1,
        sequence: 900,
        flags: LAST,
        payload: Buffer.from('truncated'),
      }),
    ),
  ).toBeNull();
  const next = encodeMessage(Buffer.from('recovered'), UPLINK_KIND, 1, 901);
  expect(decoder.add(next[0])?.body.toString()).toBe('recovered');
  const bomb = deflateSync(Buffer.alloc(MAX_DECODED_BYTES + 1, 120));
  expect(bomb.length).toBeLessThan(MAX_ENCODED_BYTES);
  expect(() => inflateMessage({ body: bomb, flags: COMPRESSED })).toThrow();
  const exact = Buffer.alloc(MAX_DECODED_BYTES, 120);
  expect(inflateMessage({ body: deflateSync(exact), flags: COMPRESSED })).toEqual(exact);
});

test('invalid sender counters and inconsistent compression cannot become delivered data', () => {
  const base = {
    kind: UPLINK_KIND,
    generation: 1,
    sequence: 0,
    flags: FIRST | LAST,
    payload: Buffer.from('data'),
  } as const;
  for (const flags of [-1, 8, 0x100000000, Number.NaN]) {
    expect(() => encodeFrame({ ...base, flags })).toThrow();
  }
  for (const sequence of [-1, 65536, 1.5, Number.NaN]) {
    expect(() => encodeMessage(base.payload, UPLINK_KIND, 1, sequence)).toThrow();
  }
  const decoder = new MailboxDecoder(UPLINK_KIND);
  expect(decoder.add(encodeFrame({ ...base, sequence: 7, flags: FIRST | COMPRESSED }))).toBeNull();
  expect(decoder.add(encodeFrame({ ...base, sequence: 8, flags: LAST }))).toBeNull();
  expect(decoder.add(encodeFrame({ ...base, sequence: 9 }))?.body).toEqual(base.payload);
});
