import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { inspectionSchema, trainingInput } from '../../src/contract/game-inspection.ts';

const decode = Schema.decodeUnknownExit(trainingInput);

it('training input validates ranges and supports inspection RPC', () => {
  expect(Exit.isFailure(decode({ minLevel: 30, maxLevel: 10 }))).toBe(true);
  expect(Exit.isFailure(decode({ limit: 10000 }))).toBe(true);
  const request = { kind: 'training', args: { query: 'Invisibilidad' } };
  expect(Schema.decodeUnknownSync(inspectionSchema)(request).kind).toBe('training');
});
