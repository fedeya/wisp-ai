// Reusable downlink state messages. Paths use JSON/JavaScript's zero-based indexes.
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { MAX_DECODED_BYTES, MAX_ENCODED_BYTES } from './mailbox.ts';

export const MAX_PATCH_OPERATIONS = 4096;
export const MAX_STATE_DEPTH = 32;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StatePath = (string | number)[];
export type StateOperation =
  | ['s', StatePath, Json]
  | ['d', StatePath]
  | ['l', StatePath, number]
  | ['a', StatePath, string];
export type DownlinkEnvelope =
  | { r: number; s: { [key: string]: Json } }
  | { r: number; b: number; p: StateOperation[] };
const downlinkAckSchema = z.strictObject({
  a: z.tuple([z.int().min(1).max(0xffffffff), z.int().min(0).max(0xffff), z.int().min(0)]),
  b: z.boolean(),
  n: z.boolean().optional(),
});
export type DownlinkAck = z.infer<typeof downlinkAckSchema>;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value: object, key: string | number) => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const unsigned = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;

function validateJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > MAX_STATE_DEPTH) {
    throw Error('Downlink state is nested too deeply');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) {
        throw Error('Sparse downlink arrays are invalid');
      }
      validateJson(value[index], depth + 1);
    }
    return;
  }
  if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (unsafe.has(key)) {
        throw Error('Unsafe downlink state key');
      }
      validateJson(child, depth + 1);
    }
    return;
  }
  throw Error('Downlink state must be JSON data');
}

function state(value: unknown): { [key: string]: Json } {
  if (!record(value) || !revision(value.rev)) {
    throw Error('Downlink state needs a positive revision');
  }
  validateJson(value);
  return value;
}

// Normalize producer objects exactly as the existing bulk JSON publication does.
function normalize(value: unknown): { [key: string]: Json } {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > MAX_DECODED_BYTES) {
    throw Error('Downlink state exceeds decoded limit');
  }
  return state(JSON.parse(json));
}

function diff(before: Json, after: Json, path: StatePath, operations: StateOperation[]) {
  if (before === after) {
    return;
  }
  const add = (operation: StateOperation) => {
    if (operations.length >= MAX_PATCH_OPERATIONS) {
      throw Error('Downlink patch operation limit reached');
    }
    operations.push(operation);
  };
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < after.length; index++) {
      const next = [...path, index];
      if (index >= before.length) {
        add(['s', next, after[index]]);
      } else {
        diff(before[index], after[index], next, operations);
      }
    }
    if (after.length < before.length) {
      add(['l', path, after.length]);
    }
  } else if (record(before) && record(after)) {
    for (const key of Object.keys(before)) {
      if (!own(after, key)) {
        add(['d', [...path, key]]);
      }
    }
    for (const [key, child] of Object.entries(after)) {
      if (!own(before, key)) {
        add(['s', [...path, key], child as Json]);
      } else {
        diff(before[key] as Json, child as Json, [...path, key], operations);
      }
    }
  } else if (
    path.length &&
    typeof before === 'string' &&
    typeof after === 'string' &&
    after.startsWith(before)
  ) {
    add(['a', path, after.slice(before.length)]);
  } else {
    add(['s', path, after]);
  }
}

function encode(envelope: DownlinkEnvelope) {
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json) > MAX_DECODED_BYTES) {
    return null;
  }
  const bytes = deflateSync(json);
  return bytes.length <= MAX_ENCODED_BYTES ? bytes : null;
}

export function prepareDownlink(snapshot: unknown, base?: unknown) {
  const next = normalize(snapshot);
  const r = Number(next.rev);
  let body = encode({ r, s: next });
  let full = true;
  if (base !== undefined) {
    const previous = normalize(base);
    if (Number(previous.rev) < r) {
      try {
        const operations: StateOperation[] = [];
        diff(previous, next, [], operations);
        if (operations.length <= MAX_PATCH_OPERATIONS) {
          const patch = encode({ r, b: Number(previous.rev), p: operations });
          if (patch && (!body || patch.length < body.length)) {
            body = patch;
            full = false;
          }
        }
      } catch {
        // An overly complex delta is optional; the complete state is canonical.
      }
    }
  }
  if (!body) {
    throw Error('Downlink message exceeds transport limits');
  }
  return { revision: r, body, full };
}

function path(value: unknown): asserts value is StatePath {
  if (
    !Array.isArray(value) ||
    value.length > MAX_STATE_DEPTH ||
    value.some(
      (part) =>
        !(typeof part === 'string' && !unsafe.has(part)) &&
        !(typeof part === 'number' && unsigned(part, MAX_DECODED_BYTES)),
    )
  ) {
    throw Error('Invalid downlink path');
  }
}

function child(container: Json, key: string | number): Json {
  if (
    (Array.isArray(container) && typeof key === 'number' && key < container.length) ||
    (record(container) && typeof key === 'string' && own(container, key))
  ) {
    return (container as Record<string | number, Json>)[key];
  }
  throw Error('Downlink path does not exist');
}

export function applyDownlink(envelope: unknown, base?: unknown): { [key: string]: Json } {
  if (!record(envelope) || !revision(envelope.r)) {
    throw Error('Invalid downlink envelope');
  }
  const r = envelope.r;
  let result: Json;
  if (own(envelope, 's')) {
    if (Object.keys(envelope).some((key) => key !== 'r' && key !== 's')) {
      throw Error('Invalid complete downlink envelope');
    }
    result = normalize(envelope.s);
  } else {
    if (
      Object.keys(envelope).some((key) => key !== 'r' && key !== 'b' && key !== 'p') ||
      !revision(envelope.b) ||
      r <= envelope.b ||
      !Array.isArray(envelope.p) ||
      envelope.p.length > MAX_PATCH_OPERATIONS
    ) {
      throw Error('Invalid downlink patch envelope');
    }
    result = normalize(base);
    if (result.rev !== envelope.b) {
      throw Error('Downlink patch requires a different base revision');
    }
    for (const operation of envelope.p) {
      if (!Array.isArray(operation) || !['s', 'd', 'l', 'a'].includes(operation[0])) {
        throw Error('Invalid downlink operation');
      }
      const [kind, location, value] = operation;
      path(location);
      if (operation.length !== (kind === 'd' ? 2 : 3)) {
        throw Error('Invalid downlink operation arguments');
      }
      if (kind === 's') {
        validateJson(value);
      }
      if (kind === 'l') {
        const target = location.reduce<Json>((container, key) => child(container, key), result);
        if (!Array.isArray(target) || !unsigned(value, target.length)) {
          throw Error('Invalid downlink array truncation');
        }
        target.length = value;
      } else if (!location.length) {
        if (kind !== 's') {
          throw Error('Cannot delete downlink root');
        }
        result = JSON.parse(JSON.stringify(value));
      } else {
        const container = location
          .slice(0, -1)
          .reduce<Json>((current, key) => child(current, key), result);
        const key = location[location.length - 1];
        let assignment: Json = value;
        if (kind === 'a') {
          const previous = child(container, key);
          if (typeof previous !== 'string' || typeof value !== 'string') {
            throw Error('Invalid downlink string append');
          }
          assignment = previous + value;
        }
        if (Array.isArray(container)) {
          if ((kind !== 's' && kind !== 'a') || typeof key !== 'number' || key > container.length) {
            throw Error('Invalid downlink array assignment');
          }
          container[key] = JSON.parse(JSON.stringify(assignment));
        } else if (record(container) && typeof key === 'string') {
          if (kind === 'd') {
            if (!own(container, key)) {
              throw Error('Cannot delete missing downlink field');
            }
            delete container[key];
          } else {
            container[key] = JSON.parse(JSON.stringify(assignment));
          }
        } else {
          throw Error('Invalid downlink assignment container');
        }
      }
    }
    // Bound the completed state too: many individually small assignments can grow it.
    result = normalize(result);
  }
  if (state(result).rev !== r) {
    throw Error('Downlink revision does not match completed state');
  }
  return result;
}

export function parseDownlinkAck(value: unknown): DownlinkAck | null {
  const result = downlinkAckSchema.safeParse(value);
  return result.success ? result.data : null;
}
