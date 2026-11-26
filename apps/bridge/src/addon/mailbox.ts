// Wisp v2 framing. Independent of the original helper-stream wire format.
import { crc32, inflateSync } from 'node:zlib';

export const UPLINK_KIND = 1;
export const DOWNLINK_KIND = 2;
export const COMPACT_ACK_KIND = 3;
export const COMPACT_DOWNLINK_KIND = 4;
export type MailboxKind =
  | typeof UPLINK_KIND
  | typeof DOWNLINK_KIND
  | typeof COMPACT_ACK_KIND
  | typeof COMPACT_DOWNLINK_KIND;
export const FIRST = 1;
export const LAST = 2;
export const COMPRESSED = 4;
export const UPLINK_BITS = 768;
export const DOWNLINK_BITS = 384;
export const HEADER_BYTES = 12;
export const CRC_BYTES = 4;
export const MAX_ENCODED_BYTES = 65536;
export const MAX_DECODED_BYTES = 1024 * 1024;

export const UPLINK_HELPERS: readonly string[] = Object.freeze(
  Array.from({ length: UPLINK_BITS }, (_, i) => `WispAI_S${String(i + 257).padStart(4, '0')}`),
);
export const DOWNLINK_HELPERS: readonly string[] = Object.freeze([
  ...Array.from({ length: 128 }, (_, i) => `WispAI_B${String(i + 1).padStart(3, '0')}`),
  ...Array.from({ length: 256 }, (_, i) => `WispAI_S${String(i + 1).padStart(4, '0')}`),
]);
const uplinkIndices = new Map(UPLINK_HELPERS.map((name, i) => [name, i]));
const downlinkIndices = new Map(DOWNLINK_HELPERS.map((name, i) => [name, i]));

export const uplinkHelper = (bitIndex: number) => UPLINK_HELPERS[bitIndex];
export const downlinkHelper = (bitIndex: number) => DOWNLINK_HELPERS[bitIndex];

export function frameBytes(kind: MailboxKind) {
  if (kind === UPLINK_KIND) {
    return UPLINK_BITS / 8;
  }
  if (kind === DOWNLINK_KIND || kind === COMPACT_DOWNLINK_KIND) {
    return DOWNLINK_BITS / 8;
  }
  if (kind === COMPACT_ACK_KIND) {
    return HEADER_BYTES + CRC_BYTES;
  }
  throw Error('Unknown Wisp mailbox lane');
}

export const payloadBytes = (kind: MailboxKind) => frameBytes(kind) - HEADER_BYTES - CRC_BYTES;

export interface MailboxFrame {
  kind: MailboxKind;
  flags: number;
  generation: number;
  sequence: number;
  payload: Buffer;
}

export interface MailboxMessage {
  generation: number;
  lastSequence: number;
  flags: number;
  body: Buffer;
}

export function encodeFrame(frame: Omit<MailboxFrame, 'payload'> & { payload: Uint8Array }) {
  const size = frameBytes(frame.kind);
  if (
    !Number.isInteger(frame.generation) ||
    frame.generation < 1 ||
    frame.generation > 0xffffffff ||
    !Number.isInteger(frame.sequence) ||
    frame.sequence < 0 ||
    frame.sequence > 0xffff ||
    !Number.isInteger(frame.flags) ||
    frame.flags < 0 ||
    frame.flags > (frame.kind === COMPACT_ACK_KIND ? 3 : 7) ||
    (frame.flags & ~7) !== 0 ||
    frame.payload.length > payloadBytes(frame.kind)
  ) {
    throw Error('Invalid Wisp mailbox frame');
  }
  const bytes = Buffer.alloc(size);
  bytes.write('W2', 0, 'ascii');
  bytes[2] = frame.kind;
  bytes[3] = frame.flags;
  bytes.writeUInt32BE(frame.generation, 4);
  bytes.writeUInt16BE(frame.sequence, 8);
  bytes.writeUInt16BE(frame.payload.length, 10);
  bytes.set(frame.payload, HEADER_BYTES);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -CRC_BYTES)), size - CRC_BYTES);
  return bytes;
}

export function decodeFrame(input: Uint8Array): MailboxFrame | null {
  if (
    input.length !== UPLINK_BITS / 8 &&
    input.length !== DOWNLINK_BITS / 8 &&
    input.length !== HEADER_BYTES + CRC_BYTES
  ) {
    return null;
  }
  const bytes = Buffer.from(input);
  if (
    bytes[0] !== 87 ||
    bytes[1] !== 50 ||
    (bytes[2] !== UPLINK_KIND &&
      bytes[2] !== DOWNLINK_KIND &&
      bytes[2] !== COMPACT_ACK_KIND &&
      bytes[2] !== COMPACT_DOWNLINK_KIND)
  ) {
    return null;
  }
  const kind = bytes[2];
  const length = bytes.readUInt16BE(10);
  if (
    bytes.length !== frameBytes(kind) ||
    (bytes[3] & (kind === COMPACT_ACK_KIND ? ~3 : ~7)) !== 0 ||
    bytes.readUInt32BE(4) === 0 ||
    length > payloadBytes(kind) ||
    bytes.readUInt32BE(bytes.length - CRC_BYTES) !== crc32(bytes.subarray(0, -CRC_BYTES))
  ) {
    return null;
  }
  // Noncanonical padding can conceal writer bugs and stale mixed-frame content.
  for (let i = HEADER_BYTES + length; i < bytes.length - CRC_BYTES; i++) {
    if (bytes[i] !== 0) {
      return null;
    }
  }
  return {
    kind,
    flags: bytes[3],
    generation: bytes.readUInt32BE(4),
    sequence: bytes.readUInt16BE(8),
    payload: bytes.subarray(HEADER_BYTES, HEADER_BYTES + length),
  };
}

function readLane(text: string, indices: ReadonlyMap<string, number>): Buffer | null {
  // Helpers are enabled by default in their TOCs. WoW can omit entries whose
  // state has never been explicitly changed from that default.
  const bytes = Buffer.alloc(indices.size / 8, 255);
  const seen = new Set<number>();
  for (const match of text.matchAll(/^([^:\r\n]+):([^\r\n]*)/gm)) {
    const index = indices.get(match[1]);
    if (index === undefined) {
      continue;
    }
    const state = match[2].trim();
    if (seen.has(index) || (state !== 'enabled' && state !== 'disabled')) {
      return null;
    }
    seen.add(index);
    if (state === 'disabled') {
      bytes[index >> 3] &= ~(1 << (index % 8));
    }
  }
  return bytes;
}

export const readUplink = (text: string) => readLane(text, uplinkIndices);
export const readDownlink = (text: string) => readLane(text, downlinkIndices);

function replaceLane(text: string, frame: Uint8Array, indices: ReadonlyMap<string, number>) {
  if (frame.length !== indices.size / 8) {
    throw Error('Wrong Wisp mailbox frame size');
  }
  const seen = new Set<number>();
  let result = text.replace(/^([^:\r\n]+):[^\r\n]*/gm, (line, name: string) => {
    const index = indices.get(name);
    if (index === undefined) {
      return line;
    }
    if (seen.has(index)) {
      throw Error('Duplicate Wisp mailbox helper');
    }
    seen.add(index);
    return `${name}: ${frame[index >> 3] & (1 << (index % 8)) ? 'enabled' : 'disabled'}`;
  });
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [name, index] of indices) {
    if (!seen.has(index)) {
      if (result && !result.endsWith('\n')) {
        result += newline;
      }
      result += `${name}: ${frame[index >> 3] & (1 << (index % 8)) ? 'enabled' : 'disabled'}${newline}`;
    }
  }
  return result;
}

export const replaceDownlink = (text: string, frame: Uint8Array) =>
  replaceLane(text, frame, downlinkIndices);
export const replaceUplink = (text: string, frame: Uint8Array) =>
  replaceLane(text, frame, uplinkIndices);

export function encodeMessage(
  body: Uint8Array,
  kind: MailboxKind,
  generation: number,
  firstSequence = 0,
  compressed = false,
) {
  if (kind === COMPACT_ACK_KIND) {
    throw Error('Compact acknowledgements are individual frames');
  }
  if (
    body.length > MAX_ENCODED_BYTES ||
    !Number.isInteger(firstSequence) ||
    firstSequence < 0 ||
    firstSequence > 0xffff
  ) {
    throw Error('Invalid Wisp mailbox message length or initial sequence');
  }
  const capacity = payloadBytes(kind);
  const count = Math.max(1, Math.ceil(body.length / capacity));
  return Array.from({ length: count }, (_, index) =>
    encodeFrame({
      kind,
      generation,
      sequence: (firstSequence + index) & 0xffff,
      flags:
        (index === 0 ? FIRST : 0) |
        (index === count - 1 ? LAST : 0) |
        (compressed ? COMPRESSED : 0),
      payload: body.subarray(index * capacity, (index + 1) * capacity),
    }),
  );
}

/** Reassembles one message at a time; packet/application ACK semantics live above it. */
export class MailboxDecoder {
  readonly kind: MailboxKind;
  private lastRaw?: Buffer;
  private generation?: number;
  private retired = new Set<number>();
  private sequence?: number;
  private parts: Buffer[] = [];
  private size = 0;
  private flags = 0;
  private assembling = false;

  constructor(kind: MailboxKind) {
    frameBytes(kind);
    if (kind === COMPACT_ACK_KIND) {
      throw Error('Compact acknowledgements are individual frames');
    }
    this.kind = kind;
  }

  reset() {
    this.lastRaw = undefined;
    this.generation = undefined;
    this.retired.clear();
    this.dropPartial();
  }

  private dropPartial() {
    this.sequence = undefined;
    this.parts = [];
    this.size = 0;
    this.flags = 0;
    this.assembling = false;
  }

  baseline(bytes: Uint8Array) {
    this.reset();
    const frame = decodeFrame(bytes);
    if (frame?.kind === this.kind) {
      this.lastRaw = Buffer.from(bytes);
      this.generation = frame.generation;
    }
  }

  add(input: Uint8Array): MailboxMessage | null {
    const frame = decodeFrame(input);
    if (!frame || frame.kind !== this.kind || this.retired.has(frame.generation)) {
      return null;
    }
    const bytes = Buffer.from(input);
    if (this.lastRaw?.equals(bytes)) {
      return null;
    }
    this.lastRaw = bytes;
    const start = (frame.flags & FIRST) !== 0;
    if (start) {
      if (this.generation !== undefined && this.generation !== frame.generation) {
        this.retired.add(this.generation);
        // Bounded stale-generation protection, in addition to application session/seq checks.
        if (this.retired.size > 16) {
          this.retired.delete(this.retired.values().next().value!);
        }
      }
      this.dropPartial();
      this.generation = frame.generation;
      this.flags = frame.flags & COMPRESSED;
      this.assembling = true;
    } else if (
      !this.assembling ||
      frame.generation !== this.generation ||
      frame.sequence !== ((this.sequence! + 1) & 0xffff) ||
      (frame.flags & COMPRESSED) !== this.flags
    ) {
      this.dropPartial();
      return null;
    }
    this.size += frame.payload.length;
    if (this.size > MAX_ENCODED_BYTES) {
      this.dropPartial();
      return null;
    }
    this.sequence = frame.sequence;
    this.parts.push(frame.payload);
    if ((frame.flags & LAST) === 0) {
      return null;
    }
    const result: MailboxMessage = {
      generation: frame.generation,
      lastSequence: frame.sequence,
      flags: this.flags,
      body: Buffer.concat(this.parts, this.size),
    };
    this.dropPartial();
    return result;
  }
}

export function inflateMessage(message: Pick<MailboxMessage, 'body' | 'flags'>) {
  if (message.body.length > MAX_ENCODED_BYTES) {
    throw Error('Wisp mailbox message exceeds encoded limit');
  }
  return message.flags & COMPRESSED
    ? inflateSync(message.body, { maxOutputLength: MAX_DECODED_BYTES })
    : Buffer.from(message.body);
}
