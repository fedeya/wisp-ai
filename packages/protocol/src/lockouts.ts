import { z } from 'zod';

export const lockoutsInput = z.strictObject({
  limit: z.number().int().min(1).max(20).default(20),
});
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const record = z.strictObject({
  index: z.number().int().min(1).max(100),
  status: z.enum(['available', 'partial']),
  name: z.string().max(160).optional(),
  difficultyId: z.number().int().nonnegative().max(1_000_000).optional(),
  difficultyName: z.string().max(96).optional(),
  locked: z.boolean().optional(),
  extended: z.boolean().optional(),
  isRaid: z.boolean().optional(),
  resetSeconds: z.number().nonnegative().max(315_360_000).optional(),
  resetText: z.string().max(80).optional(),
  lockStatus: z.enum(['active', 'inactive', 'unknown']),
  resetStatus: z.enum(['upcoming', 'expired', 'unknown']),
  textTruncated: z.boolean().optional(),
});
const cache = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unobserved'), generation: integer }),
  z.strictObject({
    status: z.literal('update_observed'),
    generation: integer,
    observedAt: integer.optional(),
    ageSeconds: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
]);
const data = z
  .strictObject({
    records: z.array(record).max(20),
    cachedCount: integer,
    scannedCount: z.number().int().nonnegative().max(100),
    returnedCount: z.number().int().nonnegative().max(20),
    truncated: z.boolean(),
    textTruncated: z.boolean(),
    budgetOmitted: z.boolean(),
    cache,
    wireUpperBoundBytes: z.number().int().positive().max(20_000),
    note: z.string().max(500),
  })
  .refine(
    (value) =>
      value.returnedCount === value.records.length &&
      value.scannedCount >= value.returnedCount &&
      value.cachedCount >= value.scannedCount,
    'Inconsistent cached lockout counts',
  );

const provenance = {
  source: z.literal('WoW saved-instance cache'),
  capturedAt: integer.optional(),
};
export const lockoutsReading = z
  .discriminatedUnion('status', [
    z.strictObject({ ...provenance, status: z.literal('unavailable'), error: z.string().max(200) }),
    z.strictObject({ ...provenance, status: z.enum(['available', 'partial']), data }),
  ])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length + 4096 <= 20_000,
    'Lockout wire budget exceeded',
  );
