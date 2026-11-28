import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, Exit, Fiber, Layer, Schema, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { routineDefinition } from '@wisp/protocol/routines';
import { CapabilitySettings } from '#/capabilities';
import { initialSession, SessionState, type RoutinePresence, type Session } from '#/session';
import { TurnRunner, type TurnRequest } from '#/turns';
import { ApplicationDatabase } from '../../src/application-database.ts';
import type { Chat } from '../../src/chat/events.ts';
import { bridgeLogging } from '../../src/logger.ts';
import { RoutineStore } from '../../src/routines/routine-store.ts';
import { start } from '../../src/routines/scheduler.ts';
import { logged } from '../logged.ts';
import { current, sessionState } from '../session-fixture.ts';

const decodeDefinition = Schema.decodeUnknownSync(routineDefinition);

/** A promise and the function that resolves it. */
function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A routine store on a database in a temporary folder, removed with the scope. */
const temporaryStore = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-routine-scheduler-'));
    const database = new ApplicationDatabase(path.join(root, 'wisp.sqlite'));
    return { root, database, store: new RoutineStore(database) };
  }),
  ({ root, database }) =>
    Effect.promise(async () => {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }),
).pipe(Effect.map(({ store }) => store));

interface SchedulerOptions {
  readonly store: RoutineStore;
  readonly session: SessionState['Service'];
  readonly run: (turn: TurnRequest) => Effect.Effect<void>;
  /** Whether a finished routine chat failed on a usage limit. */
  readonly usageLimited?: (chat: Chat) => boolean;
}

/** Starts the scheduler in a scope of its own; `stop` closes it. */
const startScheduler = Effect.fnUntraced(function* (options: SchedulerOptions) {
  const scope = yield* Scope.make();
  yield* start(options.store).pipe(
    Scope.provide(scope),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(SessionState, options.session),
        Layer.mock(CapabilitySettings, {
          agentFile: 'agent-capabilities.json',
          enabled: () => Effect.succeed(true),
        }),
        Layer.mock(TurnRunner, {
          run: options.run,
          accepting: Effect.succeed(true),
          endedOnUsageLimit: (chat) => Effect.sync(() => options.usageLimited?.(chat) ?? false),
        }),
      ),
    ),
  );
  return { stop: Scope.close(scope, Exit.void) };
});

const presenceAt = (at: number, context: unknown = { character: 'mage' }): RoutinePresence => ({
  identity: 'mage',
  session: 'session',
  ready: true,
  at,
  context,
});

describe('RoutineScheduler', () => {
  it.effect('pausing while claim awaits dispatch blocks a run even with the same updatedAt', () =>
    Effect.gen(function* () {
      const store = yield* temporaryStore;
      const start = 1_000_000;
      yield* Effect.promise(() =>
        store.mutate(
          'mage',
          {
            operation: 'save',
            routine: decodeDefinition({
              id: 'review',
              title: 'Review',
              instruction: 'Review current state.',
              triggers: [{ kind: 'event', event: 'bags_changed' }],
              cooldownSeconds: 60,
            }),
          },
          undefined,
          start,
        ),
      );
      yield* Effect.promise(() =>
        store.observe('mage', { event: 'bags_changed', values: {} }, start),
      );
      const claim = store.claim.bind(store);
      const claimed = signal();
      const releaseClaim = signal();
      const claimSpy = vi.spyOn(store, 'claim').mockImplementationOnce(async (...args) => {
        const result = await claim(...args);
        expect(result?.routine.updatedAt).toBe(start);
        expect(result?.routine.enabled).toBe(true);
        claimed.resolve();
        await releaseClaim.promise;
        return result;
      });
      let settled = signal();
      // The scheduler commits once a dispatch settles.
      const session = sessionState(
        {
          ...initialSession(),
          activeTransport: 'session',
          currentCharacterKey: 'mage',
          routinePresence: presenceAt(start),
        },
        () => settled.resolve(),
      );
      const state = () => current(session);
      const run = vi.fn((turn: TurnRequest) =>
        Effect.sync(() => {
          turn.chat.status = 'done';
        }),
      );
      // Start one tick before the mutation timestamp, so save, claim and pause
      // all happen in the same millisecond.
      yield* TestClock.setTime(start - 3000);
      const { stop } = yield* startScheduler({ store, session, run });
      yield* TestClock.adjust('3 seconds');
      yield* Effect.promise(() => claimed.promise);
      expect(store.history()).toHaveLength(1);
      expect(store.history()[0]?.status).toBe('running');
      yield* Effect.promise(() =>
        store.mutate('mage', { operation: 'pause', id: 'review' }, undefined, start),
      );
      expect(store.list('mage')[0]).toMatchObject({ enabled: false, updatedAt: start });
      releaseClaim.resolve();
      yield* Effect.promise(() => settled.promise);
      expect(run).not.toHaveBeenCalled();
      expect(state().chats).toEqual([]);
      expect(store.history()).toEqual([]);
      expect(store.list('mage')[0]?.enabled).toBe(false);
      expect(yield* logged('routine.dispatch_failed')).toEqual([]);
      expect(claimSpy).toHaveBeenCalledTimes(1);

      settled = signal();
      yield* TestClock.adjust('3 seconds');
      yield* Effect.promise(() => settled.promise);
      expect(run).not.toHaveBeenCalled();
      expect(store.history()).toEqual([]);
      expect(state().chats).toEqual([]);
      expect(store.list('mage')[0]?.enabled).toBe(false);

      const now = start + 3000;
      yield* Effect.promise(() =>
        store.mutate('mage', { operation: 'resume', id: 'review' }, undefined, now),
      );
      yield* Effect.promise(() =>
        store.observe('mage', { event: 'bags_changed', values: {} }, now),
      );
      settled = signal();
      yield* TestClock.adjust('3 seconds');
      yield* Effect.promise(() => settled.promise);
      yield* stop;
      expect(run).toHaveBeenCalledTimes(1);
      expect(state().chats).toHaveLength(1);
      expect(store.history()).toHaveLength(1);
      expect(store.history()[0]?.status).toBe('done');
      expect(store.list('mage')[0]?.enabled).toBe(true);
      expect(yield* logged('routine.dispatch_failed')).toEqual([]);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a 65-second automatic turn yields to the next routine without overlapping turns', () =>
    Effect.gen(function* () {
      const store = yield* temporaryStore;
      const start = 1_000_000;
      for (const id of ['a', 'b']) {
        yield* Effect.promise(() =>
          store.mutate(
            'mage',
            {
              operation: 'save',
              routine: decodeDefinition({
                id,
                title: id,
                instruction: 'Review current state.',
                triggers: [{ kind: 'interval', seconds: 60 }],
                cooldownSeconds: 60,
              }),
            },
            undefined,
            start,
          ),
        );
      }
      yield* TestClock.setTime(start + 57000);
      const presence = presenceAt(start + 57000);
      const startedA = signal();
      const startedB = signal();
      const releaseA = signal();
      const releaseB = signal();
      let settled = signal();
      // The scheduler commits once a dispatch settles.
      const session = sessionState(
        {
          ...initialSession(),
          activeTransport: 'session',
          currentCharacterKey: 'mage',
          routinePresence: presence,
        },
        () => settled.resolve(),
      );
      const selected: string[] = [];
      let active = 0;
      let maxActive = 0;
      const run = ({ chat }: TurnRequest) =>
        Effect.promise(async () => {
          selected.push(chat.routineId ?? '');
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
        });
      const { stop } = yield* startScheduler({ store, session, run });
      yield* TestClock.adjust('3 seconds');
      yield* Effect.promise(() => startedA.promise);
      expect(selected).toEqual(['a']);
      expect(store.history()[0]?.startedAt).toBe(start + 60000);

      // The running routine holds the ticks: none starts another turn.
      yield* TestClock.adjust('65 seconds');
      expect(selected).toEqual(['a']);
      expect(active).toBe(1);
      // Refresh the same valid character/session presence so staleness cannot block B.
      const at = start + 125000;
      yield* session.stage((state) => ({ ...state, routinePresence: { ...presence, at } }));
      releaseA.resolve();
      yield* Effect.promise(() => settled.promise);
      expect(store.history()[0]?.finishedAt).toBe(start + 125000);

      // The next tick comes on the next 3-second window, a second later.
      settled = signal();
      yield* TestClock.adjust('999 millis');
      expect(selected).toEqual(['a']);
      yield* TestClock.adjust('1 millis');
      yield* Effect.promise(() => startedB.promise);
      expect(selected).toEqual(['a', 'b']);
      expect(active).toBe(1);
      expect(maxActive).toBe(1);
      expect(store.history().map((entry) => entry.routineId)).toEqual(['a', 'b']);
      expect(store.history()[1]?.startedAt).toBe(start + 126000);
      releaseB.resolve();
      yield* Effect.promise(() => settled.promise);
      yield* stop;
      expect(store.history().map((entry) => entry.status)).toEqual(['done', 'done']);
      expect(yield* logged('routine.dispatch_failed')).toEqual([]);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('closing the scope waits for the routine that is running', () =>
    Effect.gen(function* () {
      const store = yield* temporaryStore;
      const start = 1_000_000;
      yield* Effect.promise(() =>
        store.mutate(
          'mage',
          {
            operation: 'save',
            routine: decodeDefinition({
              id: 'review',
              title: 'Review',
              instruction: 'Review current state.',
              triggers: [{ kind: 'interval', seconds: 60 }],
              cooldownSeconds: 60,
            }),
          },
          undefined,
          start,
        ),
      );
      yield* TestClock.setTime(start + 57000);
      const session = sessionState({
        ...initialSession(),
        activeTransport: 'session',
        currentCharacterKey: 'mage',
        routinePresence: presenceAt(start + 57000),
      });
      const started = signal();
      const release = signal();
      const run = ({ chat }: TurnRequest) =>
        Effect.promise(async () => {
          started.resolve();
          await release.promise;
          chat.status = 'interrupted';
        });
      const { stop } = yield* startScheduler({ store, session, run });
      yield* TestClock.adjust('3 seconds');
      yield* Effect.promise(() => started.promise);
      const stopped = yield* Effect.forkChild(stop);
      yield* Effect.yieldNow;
      expect(stopped.pollUnsafe()).toBeUndefined();
      release.resolve();
      yield* Fiber.await(stopped);
      // The run is recorded as it ended, not left running.
      expect(store.history().map((entry) => entry.status)).toEqual(['interrupted']);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('the scheduler skips unchanged quiet intervals and stops after a usage limit', () =>
    Effect.gen(function* () {
      const store = yield* temporaryStore;
      const save = (instruction: string, now: number) =>
        Effect.promise(() =>
          store.mutate(
            'mage',
            {
              operation: 'save',
              routine: decodeDefinition({
                id: 'xp',
                title: 'XP',
                instruction,
                triggers: [{ kind: 'interval', seconds: 60 }],
                cooldownSeconds: 60,
              }),
            },
            undefined,
            now,
          ),
        );
      let now = 1_000_000;
      yield* TestClock.setTime(now);
      yield* save('Tell me when I can level up.', now);
      let settled = signal();
      const session = sessionState(
        {
          ...initialSession(),
          activeTransport: 'session',
          currentCharacterKey: 'mage',
          questRevision: 1,
        },
        () => settled.resolve(),
      );
      const context = (xp: number) => ({
        sections: {
          character: {
            status: 'available',
            data: { level: 17, xp, xpMax: 9000, moneyCopper: 10 },
          },
          location: {
            status: 'available',
            data: { zone: 'Barrens', subzone: '', mapId: 10, x: 0.5, y: 0.5 },
          },
        },
      });
      const stage = (f: (state: Session) => Session) => session.stage(f);
      const present = (xp: number, at: number) =>
        stage((state) => ({ ...state, routinePresence: presenceAt(at, context(xp)) }));
      const nextQuests = stage((state) => ({
        ...state,
        questRevision: (state.questRevision ?? 0) + 1,
      }));
      const outcomes: Array<'quiet' | 'limit'> = ['quiet', 'quiet', 'quiet', 'limit'];
      const limited = new Set<Chat>();
      let runs = 0;
      const { stop } = yield* startScheduler({
        store,
        session,
        // The turn runner classifies limits from error codes; the text may not say so.
        usageLimited: (chat) => limited.has(chat),
        run: ({ chat }) =>
          Effect.sync(() => {
            const outcome = outcomes[runs++];
            if (outcome === 'limit') {
              chat.status = 'error';
              chat.messages.push({ role: 'system', text: 'Private plan details' });
              limited.add(chat);
            } else {
              chat.status = 'done';
              chat.tipSkipped = true;
            }
          }),
      });
      // A minute passes without the character, so no tick dispatches; then the
      // addon reports it again and the next tick dispatches the routine that is due.
      const minute = (xp = 100) =>
        Effect.gen(function* () {
          yield* stage((state) => ({ ...state, routinePresence: undefined }));
          yield* TestClock.adjust('57 seconds');
          now += 57_000;
          yield* present(xp, now);
          settled = signal();
          yield* TestClock.adjust('3 seconds');
          now += 3_000;
          yield* Effect.promise(() => settled.promise);
        });
      yield* minute();
      expect(runs).toBe(1);

      // Same XP, zone and quests: the next interval is dropped without a model turn.
      yield* minute();
      expect(runs).toBe(1);
      expect(store.history()).toHaveLength(1);

      // Editing the routine evaluates the new instruction even with the same state.
      yield* save('Tell me when I am close to leveling up.', now);
      yield* minute();
      expect(runs).toBe(2);

      // New XP: the routine runs again.
      yield* minute(400);
      expect(runs).toBe(3);

      // Quests changed, then the turn fails on a usage limit.
      yield* nextQuests;
      yield* minute(400);
      expect(runs).toBe(4);
      expect(store.history().at(-1)?.status).toBe('error');

      // Further intervals wait out the 30-minute pause: no tick dispatches.
      const claims = vi.spyOn(store, 'claim');
      for (let i = 0; i < 5; i++) {
        yield* nextQuests;
        yield* present(100, now);
        yield* TestClock.adjust('60 seconds');
        now += 60_000;
      }
      expect(claims).not.toHaveBeenCalled();
      expect(runs).toBe(4);
      yield* stop;
    }).pipe(Effect.provide(bridgeLogging)),
  );
});
