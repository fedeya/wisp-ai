import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspectionSchema } from '@wisp/protocol/game-inspection';
test('inspection RPC accepts bounded read-only requests and rejects arbitrary commands', () => {
  assert.equal(inspectionSchema.parse({ kind: 'target', args: {} }).kind, 'target');
  assert.equal(
    inspectionSchema.parse({ kind: 'reference', args: { kind: 'quest', id: 12 } }).kind,
    'reference',
  );
  assert.throws(() => inspectionSchema.parse({ kind: 'purchase', args: {} }));
  assert.throws(() =>
    inspectionSchema.parse({ kind: 'progression', args: { questIds: Array(41).fill(1) } }),
  );
  assert.throws(() =>
    inspectionSchema.parse({ kind: 'reference', args: { kind: 'item', id: -1 } }),
  );
});
