import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspectionSchema } from '../src/game-inspection.ts';
test('pet inspection is strictly owned-pet read-only with no executable or scan arguments', () => {
  assert.deepEqual(inspectionSchema.parse({ kind: 'pet', args: {} }), { kind: 'pet', args: {} });
  for (const args of [
    null,
    [],
    { unit: 'target' },
    { toggle: true },
    { spellId: 101 },
    { limit: 1000 },
  ]) {
    assert.throws(() => inspectionSchema.parse({ kind: 'pet', args }));
  }
  assert.throws(() => inspectionSchema.parse({ kind: 'pet', args: {}, script: 'PetAttack()' }));
});
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
