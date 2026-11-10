import { expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  MAX_PATCH_OPERATIONS,
  applyDownlink,
  parseDownlinkAck,
  prepareDownlink,
} from '../src/downlink.ts';
import { MAX_DECODED_BYTES, MAX_ENCODED_BYTES } from '../src/mailbox.ts';

const unpack = (prepared: ReturnType<typeof prepareDownlink>) =>
  JSON.parse(inflateSync(prepared.body, { maxOutputLength: MAX_DECODED_BYTES }).toString('utf8'));

test('full state is compressed, bounded and reconstructs Unicode application data', () => {
  const snapshot = {
    rev: 7,
    chats: [{ id: 'a', messages: [{ text: '¡Está vivo! 🧙‍♂️ 日本語' }] }],
    requests: [],
  };
  const prepared = prepareDownlink(snapshot);
  expect(prepared.full).toBe(true);
  expect(prepared.revision).toBe(7);
  expect(prepared.body.length).toBeLessThan(MAX_ENCODED_BYTES);
  expect(unpack(prepared)).toEqual({ r: 7, s: snapshot });
  expect(applyDownlink(unpack(prepared))).toEqual(snapshot);
  expect(applyDownlink(unpack(prepared))).not.toBe(snapshot);
});

test('incremental chat updates avoid retransmitting acknowledged history and reproduce latest state', () => {
  const base = {
    rev: 20,
    chats: Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      title: 'Conversation ' + index,
      messages: [{ id: 'm', text: 'Saved history ' + index + '.'.repeat(100) }],
      status: 'idle',
    })),
    connected: true,
  };
  const next = structuredClone(base);
  next.rev = 21;
  next.chats[29].messages[0].text += ' Respuesta nueva ❄';
  next.chats[29].status = 'working';
  const prepared = prepareDownlink(next, base);
  expect(prepared.full).toBe(false);
  const envelope = unpack(prepared);
  expect(envelope.b).toBe(20);
  expect(envelope.p).toContainEqual(['s', ['chats', 29, 'status'], 'working']);
  expect(envelope.p).toContainEqual([
    'a',
    ['chats', 29, 'messages', 0, 'text'],
    ' Respuesta nueva ❄',
  ]);
  expect(applyDownlink(envelope, base)).toEqual(next);
  expect(base.rev).toBe(20);
  expect(base.chats[29].status).toBe('idle');
  expect(() => applyDownlink(envelope, { ...base, rev: 19 })).toThrow(/base revision/);
  expect(() => applyDownlink(envelope)).toThrow();
});

test('patch application handles append, replace, object deletion and array truncation atomically', () => {
  const base = { rev: 1, list: [{ id: 'a' }, { id: 'b' }], metadata: { stale: true }, unused: 5 };
  const envelope = {
    r: 2,
    b: 1,
    p: [
      ['s', ['rev'], 2],
      ['s', ['list', 2], { id: 'c', text: 'hola' }],
      ['s', ['list', 0, 'id'], 'changed'],
      ['d', ['metadata', 'stale']],
      ['d', ['unused']],
      ['l', ['list'], 1],
    ],
  };
  expect(applyDownlink(envelope, base)).toEqual({
    rev: 2,
    list: [{ id: 'changed' }],
    metadata: {},
  });
  expect(base).toEqual({
    rev: 1,
    list: [{ id: 'a' }, { id: 'b' }],
    metadata: { stale: true },
    unused: 5,
  });
  const broken = { ...envelope, p: [...envelope.p, ['s', ['missing', 'child'], 1]] };
  expect(() => applyDownlink(broken, base)).toThrow();
  expect(base.rev).toBe(1);
  expect(base.metadata.stale).toBe(true);
});

test('malformed, sparse, dangerous and misbased patches cannot change state', () => {
  const base = { rev: 1, items: [1, 2], object: { a: 1 } };
  const malformed = [
    ['s', ['__proto__', 'polluted'], true],
    ['s', ['constructor'], true],
    ['s', ['object', 'prototype'], true],
    ['s', ['items', 4], true],
    ['s', ['items', -1], true],
    ['s', ['items', '0'], true],
    ['d', ['items', 0]],
    ['d', []],
    ['d', ['unknown']],
    ['l', ['items'], 3],
    ['l', ['items'], -1],
    ['l', ['object'], 0],
    ['s', ['object', 'a']],
    ['d', ['object', 'a'], null],
    ['x', ['object', 'a'], 2],
    ['s', Array(33).fill('a'), 1],
    ['a', [], 'x'],
    ['a', ['items', 0], 'x'],
    ['a', ['object', 'missing'], 'x'],
    ['a', ['object', 'a'], 1],
  ];
  for (const operation of malformed) {
    expect(() => applyDownlink({ r: 2, b: 1, p: [['s', ['rev'], 2], operation] }, base)).toThrow();
  }
  expect(base).toEqual({ rev: 1, items: [1, 2], object: { a: 1 } });
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  expect(() => applyDownlink({ r: 2, b: 1, p: [] }, base)).toThrow(/revision/);
  expect(() => applyDownlink({ r: 1, b: 1, p: [] }, base)).toThrow();
  expect(() => applyDownlink({ r: 1, s: { rev: 2 } })).toThrow(/revision/);
  expect(() => applyDownlink({ r: 1, s: base, b: 1, p: [] })).toThrow();
  expect(() =>
    applyDownlink({ r: 2, b: 1, p: Array(MAX_PATCH_OPERATIONS + 1).fill([]) }, base),
  ).toThrow();
});

test('string append sends only new streaming text and handles Unicode without character slicing', () => {
  const history = randomBytes(5000).toString('base64');
  const base = { rev: 100, text: history, array: ['¿Cómo va?'] };
  const next = { rev: 101, text: history + ' 🧙 ¡Bien!', array: ['¿Cómo va? 日本語'] };
  const prepared = prepareDownlink(next, base);
  expect(prepared.full).toBe(false);
  const envelope = unpack(prepared);
  expect(envelope.p).toEqual([
    ['s', ['rev'], 101],
    ['a', ['text'], ' 🧙 ¡Bien!'],
    ['a', ['array', 0], ' 日本語'],
  ]);
  expect(prepared.body.length).toBeLessThan(150);
  expect(applyDownlink(envelope, base)).toEqual(next);
});

test('overly complex patches fall back to bounded complete state', () => {
  const oldFields = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['old' + i, i]));
  const newFields = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['new' + i, i]));
  const base = { rev: 1, data: oldFields };
  const next = { rev: 2, data: newFields };
  const prepared = prepareDownlink(next, base);
  expect(prepared.full).toBe(true);
  expect(applyDownlink(unpack(prepared), base)).toEqual(next);
});

test('generated deletion and append deltas round trip realistic snapshot edits', () => {
  const base = {
    rev: 50,
    chats: Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      text: 'Old message ' + index,
      old: true,
    })),
    cache: { a: 1, b: 2 },
    retired: 'field',
  };
  const shorter = {
    rev: 51,
    chats: base.chats.slice(0, 79).map(({ id, text }) => ({ id, text })),
    cache: { a: 1 },
  };
  const appended = {
    ...shorter,
    rev: 52,
    chats: [...shorter.chats, { id: 'new', text: 'Appended' }],
  };
  for (const [before, after] of [
    [base, shorter],
    [shorter, appended],
  ]) {
    const prepared = prepareDownlink(after, before);
    expect(applyDownlink(unpack(prepared), before)).toEqual(after);
  }
});

test('producer selects complete state when smaller and enforces both transport size limits', () => {
  const prepared = prepareDownlink({ rev: 2, value: true }, { rev: 1, value: false });
  expect(prepared.full).toBe(true);
  expect(() => prepareDownlink({ rev: 1, text: 'x'.repeat(MAX_DECODED_BYTES) })).toThrow(/limit/);
  expect(() =>
    prepareDownlink({ rev: 1, text: randomBytes(MAX_ENCODED_BYTES + 1024).toString('base64') }),
  ).toThrow(/limit/);
  let nested: unknown = 1;
  for (let index = 0; index < 34; index++) {
    nested = { child: nested };
  }
  expect(() => prepareDownlink({ rev: 1, nested })).toThrow(/deeply/);
  expect(() => prepareDownlink({ rev: 0 })).toThrow(/revision/);
});

test('transport ACK validation is strict and independent from application dispatch', () => {
  expect(parseDownlinkAck({ a: [0xffffffff, 65535, 0], b: false, n: true })).toEqual({
    a: [0xffffffff, 65535, 0],
    b: false,
    n: true,
  });
  expect(parseDownlinkAck({ a: [1, 0, Number.MAX_SAFE_INTEGER], b: true })).not.toBeNull();
  const invalid = [
    null,
    [],
    {},
    { a: [1, 2, 3] },
    { a: [0, 1, 2], b: true },
    { a: [0x100000000, 1, 2], b: true },
    { a: [1, 65536, 2], b: true },
    { a: [1, 0, -1], b: true },
    { a: [1, 0, 1.5], b: true },
    { a: [1, 0, 1, 2], b: true },
    { a: [1, 0, 1], b: true, n: 1 },
    { a: [1, 0, 1], b: true, type: 'say' },
  ];
  for (const value of invalid) {
    expect(parseDownlinkAck(value)).toBeNull();
  }
});
