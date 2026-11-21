import { test } from 'vitest';
import assert from 'node:assert/strict';
import { combatInput, inspectionSchema } from '../src/game-inspection.ts';
test('combat schema defaults to the latest death and bounds reads', () => {
  assert.deepEqual(combatInput.parse({}), {
    view: 'deaths',
    deaths: 1,
    includeGroup: false,
    eventLimit: 20,
  });
  assert(inspectionSchema.safeParse({ kind: 'combat', args: { view: 'fight' } }).success);
  for (const input of [
    { deaths: 6 },
    { eventLimit: 31 },
    { view: 'recent' },
    { includeGroup: 'yes' },
    { unit: 'target' },
  ]) {
    assert(!combatInput.safeParse(input).success);
  }
});
