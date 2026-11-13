import { test, expect } from 'vitest';
import { inspectionSchema } from '../src/game-inspection.ts';
import { defaultCapabilities } from '../src/capabilities.ts';

test('merchant inspection is registered and accepts only bounded read-only inputs', () => {
  expect(inspectionSchema.parse({ kind: 'merchant', args: {} })).toEqual({
    kind: 'merchant',
    args: { offset: 0, limit: 20 },
  });
  for (const args of [{ limit: 41 }, { offset: 501 }, { limit: -1 }, { buy: 1 }]) {
    expect(() => inspectionSchema.parse({ kind: 'merchant', args })).toThrow();
  }
  expect(defaultCapabilities().some((c) => c.id === 'tool:inspect_merchant')).toBe(true);
});
