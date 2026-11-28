import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { inspectionSchema } from '../../src/contract/game-inspection.ts';

const decode = Schema.decodeUnknownSync(inspectionSchema);

it('inspection RPC accepts bounded read-only requests and rejects arbitrary commands', () => {
  expect(decode({ kind: 'target', args: {} }).kind).toBe('target');
  expect(decode({ kind: 'reference', args: { kind: 'quest', id: 12 } }).kind).toBe('reference');
  expect(() => decode({ kind: 'purchase', args: {} })).toThrow();
  expect(() => decode({ kind: 'progression', args: { questIds: Array(41).fill(1) } })).toThrow();
  expect(() => decode({ kind: 'reference', args: { kind: 'item', id: -1 } })).toThrow();
});
