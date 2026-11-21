import { test } from 'vitest';
import assert from 'node:assert/strict';
import { combatLogInput, inspectionSchema } from '../src/game-inspection.ts';
test('combat log schema defaults to the latest death and bounds reads', () => {
  assert.deepEqual(combatLogInput.parse({}), {
    view: 'deaths',
    deaths: 1,
    lastSeconds: 30,
    eventLimit: 40,
  });
  assert(inspectionSchema.safeParse({ kind: 'combat', args: { view: 'recent' } }).success);
  for (const input of [
    { deaths: 6 },
    { lastSeconds: 121 },
    { eventLimit: 61 },
    { view: 'all' },
    { unit: 'target' },
  ]) {
    assert(!combatLogInput.safeParse(input).success);
  }
});
