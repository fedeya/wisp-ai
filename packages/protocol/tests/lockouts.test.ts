import { expect, test } from 'vitest';
import { inspectionSchema } from '../src/game-inspection.ts';
import { lockoutsInput, lockoutsReading } from '../src/lockouts.ts';

test('cached lockout protocol bounds and strictly rejects refresh, actions and executable arguments', () => {
  expect(lockoutsInput.parse({})).toEqual({ limit: 20 });
  for (const args of [
    { refresh: true },
    { limit: 21 },
    { limit: 0 },
    { limit: 1.5 },
    { script: 'x' },
    { extend: true },
  ]) {
    expect(inspectionSchema.safeParse({ kind: 'lockouts', args }).success).toBe(false);
  }
  expect(inspectionSchema.parse({ kind: 'lockouts', args: { limit: 2 } })).toEqual({
    kind: 'lockouts',
    args: { limit: 2 },
  });
  expect(inspectionSchema.safeParse({ kind: 'lockouts', args: {}, refresh: true }).success).toBe(
    false,
  );
});

test('lockout responses cannot silently accept an unsafe ID, invented freshness or oversized envelope', () => {
  const result = {
    status: 'available',
    source: 'WoW saved-instance cache',
    capturedAt: 1000,
    data: {
      records: [],
      cachedCount: 0,
      scannedCount: 0,
      returnedCount: 0,
      truncated: false,
      textTruncated: false,
      budgetOmitted: false,
      cache: { status: 'unobserved', generation: 0 },
      wireUpperBoundBytes: 4000,
      note: 'Cached zero is not eligibility.',
    },
  };
  expect(lockoutsReading.safeParse(result).success).toBe(true);
  expect(lockoutsReading.safeParse({ ...result, fresh: true }).success).toBe(false);
  expect(
    lockoutsReading.safeParse({ ...result, data: { ...result.data, note: 'x'.repeat(20001) } })
      .success,
  ).toBe(false);
  expect(
    lockoutsReading.safeParse({
      ...result,
      data: {
        ...result.data,
        records: [
          {
            index: 1,
            instanceId: {},
            status: 'partial',
            lockStatus: 'unknown',
            resetStatus: 'unknown',
          },
        ],
      },
    }).success,
  ).toBe(false);
});
