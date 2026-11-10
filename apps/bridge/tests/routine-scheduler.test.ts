import { test, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationDatabase } from '@wisp/bridge/db/application-database';
import { RoutineStore } from '@wisp/bridge/routines';
import { startRoutineScheduler } from '@wisp/bridge/routine-scheduler';
import { createSessionState } from '@wisp/bridge/session-state';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { routineDefinition } from '@wisp/protocol/routines';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a 65-second automatic turn yields to the next routine without overlapping turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-routine-scheduler-'));
  const database = new ApplicationDatabase(path.join(root, 'wisp.sqlite'));
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const releaseA = signal();
  const releaseB = signal();
  let stop: (() => Promise<void>) | undefined;
  try {
    const start = 1000000;
    vi.setSystemTime(start);
    const store = new RoutineStore(database);
    for (const id of ['a', 'b']) {
      await store.mutate('mage', {
        operation: 'save',
        routine: routineDefinition.parse({
          id,
          title: id,
          instruction: 'Review current state.',
          triggers: [{ kind: 'interval', seconds: 60 }],
          cooldownSeconds: 60,
        }),
      });
    }
    const state = createSessionState();
    state.activeTransport = 'session';
    state.currentCharacterKey = 'mage';
    vi.setSystemTime(start + 57000);
    state.routinePresence = {
      identity: 'mage',
      session: 'session',
      ready: true,
      at: Date.now(),
      context: { character: 'mage' },
    };
    const startedA = signal();
    const startedB = signal();
    const settledA = signal();
    const selected: string[] = [];
    let active = 0;
    let maxActive = 0;
    const log = vi.fn();
    stop = startRoutineScheduler({
      state,
      routineStore: store,
      capabilitySettings: new CapabilitySettings(path.join(root, 'capabilities.json')),
      isStopping: () => false,
      isReady: () => true,
      log,
      changed: () => settledA.resolve(),
      run: async (chat) => {
        selected.push(chat.routineId!);
        active++;
        maxActive = Math.max(maxActive, active);
        chat.status = 'working';
        if (selected.length === 1) {
          startedA.resolve();
          await releaseA.promise;
        } else {
          startedB.resolve();
          await releaseB.promise;
        }
        chat.status = 'done';
        active--;
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    await startedA.promise;
    expect(selected).toEqual(['a']);
    expect(store.history()[0].startedAt).toBe(start + 60000);

    await vi.advanceTimersByTimeAsync(65000);
    expect(selected).toEqual(['a']);
    expect(active).toBe(1);
    // Refresh the same valid character/session presence so staleness cannot block B.
    state.routinePresence = { ...state.routinePresence, at: Date.now() };
    releaseA.resolve();
    await settledA.promise;
    expect(store.history()[0].finishedAt).toBe(start + 125000);

    await vi.advanceTimersByTimeAsync(1000);
    await startedB.promise;
    expect(selected).toEqual(['a', 'b']);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);
    expect(store.history().map((run) => run.routineId)).toEqual(['a', 'b']);
    releaseB.resolve();
    await stop();
    expect(store.history().map((run) => run.status)).toEqual(['done', 'done']);
    expect(log).not.toHaveBeenCalled();
  } finally {
    releaseA.resolve();
    releaseB.resolve();
    await stop?.();
    vi.useRealTimers();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
