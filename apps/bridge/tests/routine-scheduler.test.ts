import { test, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationDatabase } from '../src/db/application-database.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { startRoutineScheduler } from '../src/routines/routine-scheduler.ts';
import { createSessionState } from '../src/session-state.ts';
import { CapabilitySettings } from '../src/integrations/capabilities.ts';
import { routineDefinition } from '@wisp/protocol/routines';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('pausing while claim awaits dispatch blocks a run even with the same updatedAt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-routine-scheduler-'));
  const database = new ApplicationDatabase(path.join(root, 'wisp.sqlite'));
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const releaseClaim = signal();
  let stop: (() => Promise<void>) | undefined;
  try {
    const start = 1000000;
    vi.setSystemTime(start);
    const store = new RoutineStore(database);
    await store.mutate('mage', {
      operation: 'save',
      routine: routineDefinition.parse({
        id: 'review',
        title: 'Review',
        instruction: 'Review current state.',
        triggers: [{ kind: 'event', event: 'bags_changed' }],
        cooldownSeconds: 60,
      }),
    });
    await store.observe('mage', { event: 'bags_changed', values: {} });
    const claim = store.claim.bind(store);
    const claimed = signal();
    using claimSpy = vi.spyOn(store, 'claim').mockImplementationOnce(async (...args) => {
      const result = await claim(...args);
      expect(result?.routine.updatedAt).toBe(start);
      expect(result?.routine.enabled).toBe(true);
      claimed.resolve();
      await releaseClaim.promise;
      return result;
    });
    const state = createSessionState();
    state.activeTransport = 'session';
    state.currentCharacterKey = 'mage';
    state.routinePresence = {
      identity: 'mage',
      session: 'session',
      ready: true,
      at: start,
      context: { character: 'mage' },
    };
    const settled = signal();
    const run = vi.fn(async (chat: (typeof state.chats)[number]) => {
      chat.status = 'done';
    });
    const logger = { error: vi.fn() };
    // Arm the interval one tick before the mutation timestamp so save, claim,
    // and pause all happen in the same millisecond without any real-time race.
    vi.setSystemTime(start - 3000);
    stop = startRoutineScheduler({
      state,
      routineStore: store,
      capabilitySettings: new CapabilitySettings(path.join(root, 'capabilities.json')),
      isStopping: () => false,
      isReady: () => true,
      logger,
      changed: () => settled.resolve(),
      run,
    });
    await vi.advanceTimersByTimeAsync(3000);
    await claimed.promise;
    expect(store.history()).toHaveLength(1);
    expect(store.history()[0].status).toBe('running');
    await store.mutate('mage', { operation: 'pause', id: 'review' });
    expect(store.list('mage')[0]).toMatchObject({ enabled: false, updatedAt: start });
    releaseClaim.resolve();
    await settled.promise;
    expect(run).not.toHaveBeenCalled();
    expect(state.chats).toEqual([]);
    expect(store.history()).toEqual([]);
    expect(store.list('mage')[0].enabled).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
    expect(claimSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(run).not.toHaveBeenCalled();
    expect(store.history()).toEqual([]);
    expect(state.chats).toEqual([]);
    expect(store.list('mage')[0].enabled).toBe(false);

    await store.mutate('mage', { operation: 'resume', id: 'review' });
    await store.observe('mage', { event: 'bags_changed', values: {} });
    await vi.advanceTimersByTimeAsync(3000);
    await stop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.chats).toHaveLength(1);
    expect(store.history()).toHaveLength(1);
    expect(store.history()[0].status).toBe('done');
    expect(store.list('mage')[0].enabled).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    releaseClaim.resolve();
    await stop?.();
    vi.useRealTimers();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    const logger = { error: vi.fn() };
    stop = startRoutineScheduler({
      state,
      routineStore: store,
      capabilitySettings: new CapabilitySettings(path.join(root, 'capabilities.json')),
      isStopping: () => false,
      isReady: () => true,
      logger,
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
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    releaseA.resolve();
    releaseB.resolve();
    await stop?.();
    vi.useRealTimers();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
