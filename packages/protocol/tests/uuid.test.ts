import { expect, test } from 'vitest';
import { uuidv7, uuidv7Time } from '../src/uuid.ts';

test('a UUID v7 carries its creation time and the version and variant bits', () => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0, 123);
  const id = uuidv7(now);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(uuidv7Time(id)).toBe(now);
});

test('UUID v7s made later sort after earlier ones and do not repeat', () => {
  const earlier = uuidv7(1_000);
  const later = uuidv7(2_000);
  expect([later, earlier].sort()).toEqual([earlier, later]);
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(5_000)));
  expect(ids.size).toBe(1000);
});
