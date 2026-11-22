import { test, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationDatabase } from '../src/db/application-database.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { startRoutineScheduler } from '../src/routines/routine-scheduler.ts';
import { createRoutineGate, routineFingerprint } from '../src/routines/routine-gate.ts';
import { createSessionState } from '../src/session-state.ts';
import { CapabilitySettings } from '../src/integrations/capabilities.ts';
import { routineDefinition } from '@wisp/protocol/routines';

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

test('the scheduler skips unchanged quiet intervals and stops after a usage limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-routine-gate-'));
  const database = new ApplicationDatabase(path.join(root, 'wisp.sqlite'));
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  let stop: (() => Promise<void>) | undefined;
  try {
    vi.setSystemTime(1_000_000);
    const store = new RoutineStore(database);
    await store.mutate('mage', {
      operation: 'save',
      routine: routineDefinition.parse({
        id: 'xp',
        title: 'XP',
        instruction: 'Tell me when I can level up.',
        triggers: [{ kind: 'interval', seconds: 60 }],
        cooldownSeconds: 60,
      }),
    });
    const state = createSessionState();
    state.activeTransport = 'session';
    state.currentCharacterKey = 'mage';
    state.questRevision = 1;
    const present = (xp: number) => {
      state.routinePresence = {
        identity: 'mage',
        session: 'session',
        ready: true,
        at: Date.now(),
        context: context(xp),
      };
    };
    const outcomes: Array<'quiet' | 'limit'> = ['quiet', 'quiet', 'quiet', 'limit'];
    const limited = new Set<unknown>();
    let runs = 0;
    stop = startRoutineScheduler({
      state,
      routineStore: store,
      capabilitySettings: new CapabilitySettings(path.join(root, 'capabilities.json')),
      isStopping: () => false,
      isReady: () => true,
      logger: { error: vi.fn() },
      changed: () => {},
      // The turn runner classifies limits from error codes; the text may not say so.
      usageLimited: (chat) => limited.has(chat),
      run: async (chat) => {
        const outcome = outcomes[runs++];
        if (outcome === 'limit') {
          chat.status = 'error';
          chat.messages.push({ role: 'system', text: 'Private plan details' });
          limited.add(chat);
        } else {
          chat.status = 'done';
          chat.tipSkipped = true;
        }
      },
    });
    const minute = async (xp = 100) => {
      vi.setSystemTime(Date.now() + 60_000);
      present(xp);
      await vi.advanceTimersByTimeAsync(3000);
    };
    present(100);
    await minute();
    expect(runs).toBe(1);

    // Same XP, zone and quests: the next interval is dropped without a model turn.
    await minute();
    expect(runs).toBe(1);
    expect(store.history()).toHaveLength(1);

    // Editing the routine evaluates the new instruction even with the same state.
    await store.mutate('mage', {
      operation: 'save',
      routine: routineDefinition.parse({
        id: 'xp',
        title: 'XP',
        instruction: 'Tell me when I am close to leveling up.',
        triggers: [{ kind: 'interval', seconds: 60 }],
        cooldownSeconds: 60,
      }),
    });
    await minute();
    expect(runs).toBe(2);

    // New XP: the routine runs again.
    vi.setSystemTime(Date.now() + 60_000);
    present(400);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(3);

    // Quests changed, then the turn fails on a usage limit.
    state.questRevision = 2;
    vi.setSystemTime(Date.now() + 60_000);
    present(400);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(4);
    expect(store.history().at(-1)?.status).toBe('error');

    // Further intervals wait out the 30-minute pause.
    for (let i = 0; i < 5; i++) {
      state.questRevision++;
      await minute();
    }
    expect(runs).toBe(4);
  } finally {
    await stop?.();
    vi.useRealTimers();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
