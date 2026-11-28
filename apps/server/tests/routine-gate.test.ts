import { test, expect } from 'vitest';
import { createRoutineGate, routineFingerprint } from '../src/routines/routine-gate.ts';

function context(xp: number, x = 0.5) {
  return {
    sections: {
      character: { status: 'available', data: { level: 17, xp, xpMax: 9000, moneyCopper: 10 } },
      location: {
        status: 'available',
        data: { zone: 'Barrens', subzone: '', mapId: 10, x, y: 0.5 },
      },
    },
  };
}

test('fingerprints ignore map coordinates but follow XP and quest changes', () => {
  expect(routineFingerprint(context(100, 0.1), 3)).toBe(routineFingerprint(context(100, 0.9), 3));
  expect(routineFingerprint(context(100), 3)).not.toBe(routineFingerprint(context(200), 3));
  expect(routineFingerprint(context(100), 3)).not.toBe(routineFingerprint(context(100), 4));
  expect(routineFingerprint(context(100), undefined)).toBeUndefined();
  expect(routineFingerprint({ character: 'mage' }, 3)).toBeUndefined();
});

test('only interval runs after a quiet run with the same state are skipped', () => {
  const gate = createRoutineGate();
  gate.finished('xp', 'no_tip', 'same', false);
  expect(gate.unchanged('xp', 'interval', 'same')).toBe(true);
  expect(gate.unchanged('xp', 'level_up', 'same')).toBe(false);
  expect(gate.unchanged('xp', 'interval', 'changed')).toBe(false);
  expect(gate.unchanged('other', 'interval', 'same')).toBe(false);
  gate.finished('xp', 'done', 'same', false);
  expect(gate.unchanged('xp', 'interval', 'same')).toBe(false);
});

test('an unchanged snapshot is rechecked at least every 30 minutes', () => {
  const gate = createRoutineGate();
  const minute = 60_000;
  gate.finished('timer', 'no_tip', 'same', false, 0);
  expect(gate.unchanged('timer', 'interval', 'same', 29 * minute)).toBe(true);
  expect(gate.unchanged('timer', 'interval', 'same', 30 * minute)).toBe(false);
});

test('usage limits pause routines with growing backoff until a run succeeds', () => {
  const gate = createRoutineGate();
  const minute = 60_000;
  gate.finished('xp', 'error', undefined, true, 0);
  expect(gate.paused(29 * minute)).toBe(true);
  expect(gate.paused(30 * minute)).toBe(false);
  gate.finished('xp', 'error', undefined, true, 30 * minute);
  expect(gate.paused(89 * minute)).toBe(true);
  expect(gate.paused(90 * minute)).toBe(false);
  for (let i = 0; i < 5; i++) {
    gate.finished('xp', 'error', undefined, true, 0);
  }
  expect(gate.paused(4 * 60 * minute - 1)).toBe(true);
  expect(gate.paused(4 * 60 * minute)).toBe(false);
  gate.finished('xp', 'error', undefined, false, 0);
  expect(gate.paused(1)).toBe(true);
  gate.finished('xp', 'no_tip', undefined, false, 0);
  expect(gate.paused(1)).toBe(false);
});
