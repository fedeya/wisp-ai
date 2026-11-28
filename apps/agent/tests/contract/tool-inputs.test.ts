import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import {
  auctionInput,
  gearCandidatesInput,
  inspectionParseOptions,
  inspectionSchema,
  objectLocationsInput,
  trainingInput,
} from '../../src/contract/game-inspection.ts';
import {
  Const,
  DiscriminatedUnion,
  LimitedString,
  NoArgs,
  NoArgsStrict,
  NumberBetween,
  zodJsonSchemaKey,
} from '../../src/contract/tool-inputs.ts';
import { effectToolInput } from '../../src/tools/tool.ts';
import type { GameInspection } from '../../src/contract/game-inspection-results.ts';

// Where zod and Schema differ by default, the contracts keep zod's behavior.

const inspect = (kind: GameInspection['kind'], args: unknown) =>
  Schema.decodeUnknownExit(inspectionSchema)({ kind, args }, inspectionParseOptions(kind));
const decoded = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, { onSuccess: (value) => value, onFailure: () => undefined });

describe('inspection arguments', () => {
  it('drop unknown keys where zod used an object and reject them where it used a strict one', () => {
    expect(decoded(inspect('auctions', { itemId: 1, page: 2 }))).toEqual({
      kind: 'auctions',
      args: { itemId: 1, limit: 20 },
    });
    expect(Exit.isFailure(inspect('flight_paths', { origin: 'Goldshire', page: 2 }))).toBe(true);
  });

  it('read no arguments from an object, as zod did', () => {
    expect(decoded(inspect('target', { unit: 'focus' }))).toEqual({ kind: 'target', args: {} });
    for (const args of [[], 'target', 1, null]) {
      expect(Exit.isFailure(inspect('target', args)), JSON.stringify(args)).toBe(true);
    }
    expect(Exit.isSuccess(Schema.decodeUnknownExit(NoArgsStrict)({}))).toBe(true);
    expect(Exit.isFailure(Schema.decodeUnknownExit(NoArgsStrict)({ itemId: 1 }))).toBe(true);
    expect(Exit.isFailure(Schema.decodeUnknownExit(NoArgs)([]))).toBe(true);
  });

  it('take a fresh copy of an array default for every decode', () => {
    const first = Schema.decodeUnknownSync(inspectionSchema)({ kind: 'map', args: {} });
    const second = Schema.decodeUnknownSync(inspectionSchema)({ kind: 'map', args: {} });
    expect(first).toEqual({ kind: 'map', args: { mapIds: [] } });
    expect(first.args).not.toBe(second.args);
    expect('mapIds' in first.args && 'mapIds' in second.args).toBe(true);
  });

  it('reject an explicit undefined in a model input, which JSON cannot carry', () => {
    const decode = Schema.decodeUnknownExit(auctionInput);
    expect(Exit.isFailure(decode({ limit: undefined }))).toBe(true);
    expect(Exit.isFailure(decode({ itemId: undefined }))).toBe(true);
    expect(decoded(decode({}))).toEqual({ limit: 20 });
  });

  it('take an explicit undefined where only Wisp builds the input', () => {
    const decode = Schema.decodeUnknownExit(gearCandidatesInput);
    expect(decoded(decode({ itemIds: [1], minRequiredLevel: undefined }))).toEqual({
      itemIds: [1],
      minRequiredLevel: undefined,
    });
  });
});

describe('a bounded number', () => {
  it('takes any finite number in range, as zod’s z.number().min().max()', () => {
    const decode = Schema.decodeUnknownExit(NumberBetween(0, 100));
    for (const input of [0, 51.9, 100]) {
      expect(decoded(decode(input))).toBe(input);
    }
    for (const input of [-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY, '50', null]) {
      expect(Exit.isFailure(decode(input)), String(input)).toBe(true);
    }
  });
});

describe('a discriminated union', () => {
  const union = DiscriminatedUnion([
    Schema.Struct({ operation: Const('preview'), id: LimitedString(1, 400) }),
    Schema.Struct({ operation: Const('apply'), transactionId: LimitedString(1, 100) }),
  ]);
  const modelSchema = (layout: 'effect' | 'zod') =>
    effectToolInput(union, { layout })['~standard'].jsonSchema.input({ target: 'draft-2020-12' });

  it('decodes the member its literal names, and nothing else', () => {
    const decode = Schema.decodeUnknownExit(union);
    expect(decoded(decode({ operation: 'apply', transactionId: 't1' }))).toEqual({
      operation: 'apply',
      transactionId: 't1',
    });
    for (const input of [
      { operation: 'execute', id: 'x' },
      { operation: 'apply', id: 'x' },
      { operation: 'apply', transactionId: '' },
      { transactionId: 't1' },
    ]) {
      expect(Exit.isFailure(decode(input)), JSON.stringify(input)).toBe(true);
    }
  });

  it('shows the model oneOf and const, as zod wrote them', () => {
    // Effect writes anyOf here: a string length is looser in JSON Schema.
    expect(modelSchema('zod')).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      oneOf: [
        {
          type: 'object',
          properties: {
            operation: { type: 'string', const: 'preview' },
            id: { type: 'string', minLength: 1, maxLength: 400 },
          },
          required: ['operation', 'id'],
        },
        {
          type: 'object',
          properties: {
            operation: { type: 'string', const: 'apply' },
            transactionId: { type: 'string', minLength: 1, maxLength: 100 },
          },
          required: ['operation', 'transactionId'],
        },
      ],
    });
  });

  it('leaves Effect’s own layout as Effect writes it', () => {
    const json = JSON.stringify(modelSchema('effect'));
    expect(json).toContain('"anyOf"');
    expect(json).toContain('"enum":["preview"]');
    expect(json).not.toContain(zodJsonSchemaKey);
  });
});

describe('a tool input', () => {
  // The issues the model reads when its input is invalid.
  const issues = (schema: Parameters<typeof effectToolInput>[0], input: unknown) =>
    Effect.promise(() =>
      Promise.resolve(
        effectToolInput(schema, { parseOptions: rejectUnknownKeys })['~standard'].validate(input),
      ),
    ).pipe(Effect.map((result) => result.issues?.map((issue) => issue.message)));

  it.effect('names the refinement it broke in zod’s words', () =>
    Effect.gen(function* () {
      expect(yield* issues(objectLocationsInput, { limit: 3 })).toEqual([
        'Provide an object ID or exact localized name',
      ]);
      expect(yield* issues(trainingInput, { minLevel: 20, maxLevel: 10 })).toEqual([
        'Invalid level range',
      ]);
    }),
  );
});
