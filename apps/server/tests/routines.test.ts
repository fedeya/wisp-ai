import { test, expect } from 'vitest';
import { it } from '@effect/vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { importProductData } from '../src/migrations/product-json.ts';
import { reopen, testStorage, TestDirectory } from './storage-fixture.ts';
import {
  routineDefinition,
  routineInput,
  matchesRoutineEvent,
  savedRoutine,
} from '@wisp/protocol/routines';

const definition = () =>
  routineDefinition.parse({
    id: 'mage',
    title: 'Mage review',
    instruction: 'Read current spells and advise only if useful.',
    triggers: [
      {
        kind: 'event',
        event: 'level_up',
        filters: [{ field: 'level', op: 'multiple_of', value: 2 }],
      },
    ],
    cooldownSeconds: 60,
  });
const withStore = <A, E, R>(work: (store: RoutineStore['Service']) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* work(yield* RoutineStore);
  }).pipe(Effect.provide(testStorage()));

/** The routine store over another connection, after recovering what a restart recovers. */
const restarted = <A, E, R>(work: (store: RoutineStore['Service']) => Effect.Effect<A, E, R>) =>
  reopen(
    Effect.gen(function* () {
      const store = yield* RoutineStore;
      yield* store.recover();
      return yield* work(store);
    }),
  );

test('event definitions reject invented capabilities, invalid operators and executable extras', () => {
  const d = definition();
  expect(matchesRoutineEvent(d.triggers[0], { event: 'level_up', values: { level: 24 } })).toBe(
    true,
  );
  expect(matchesRoutineEvent(d.triggers[0], { event: 'level_up', values: { level: 25 } })).toBe(
    false,
  );
  expect(matchesRoutineEvent(d.triggers[0], { event: 'level_up', values: {} })).toBe(false);
  for (const triggers of [
    [{ kind: 'event', event: 'invented' }],
    [{ kind: 'event', event: 'level_up', filters: [{ field: 'gold', op: 'eq', value: 1 }] }],
    [{ kind: 'event', event: 'level_up', filters: [{ field: 'level', op: 'contains', value: 2 }] }],
    [
      {
        kind: 'event',
        event: 'level_up',
        filters: [{ field: 'level', op: 'multiple_of', value: 0 }],
      },
    ],
    [{ kind: 'interval', seconds: 1 }],
  ]) {
    expect(routineDefinition.safeParse({ ...d, triggers }).success).toBe(false);
  }
  expect(
    routineInput.safeParse({ operation: 'save', routine: { ...d, script: 'run()' } }).success,
  ).toBe(false);
});
it.live(
  'pending events survive restart, coalesce, respect cooldown and stay character scoped',
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const start = 1000000;
        yield* store.mutate(
          'mage',
          { operation: 'save', routine: definition() },
          'creation-chat',
          start,
        );
        yield* store.observe('other', { event: 'level_up', values: { level: 24 } }, start);
        expect(yield* store.claim('mage', start)).toBeNull();
        yield* store.observe('mage', { event: 'level_up', values: { level: 24 } }, start);
        yield* store.observe('mage', { event: 'level_up', values: { level: 26 } }, start + 1);
        yield* restarted((restored) =>
          Effect.gen(function* () {
            const claims = yield* Effect.all(
              [restored.claim('mage', start + 2), restored.claim('mage', start + 2)],
              { concurrency: 'unbounded' },
            );
            expect(claims.filter(Boolean)).toHaveLength(1);
            const first = claims.find(Boolean)!;
            expect(first.event.values.level).toBe(26);
            expect(first.routine.sourceChatId).toBe('creation-chat');
            yield* restored.finish(first.run.id, 'done', 'Train the verified spell.', start + 3);
            yield* restored.observe(
              'mage',
              { event: 'level_up', values: { level: 28 } },
              start + 4,
            );
            expect(yield* restored.claim('mage', start + 1000)).toBeNull();
            const second = (yield* restored.claim('mage', start + 60002))!;
            expect(second.run.id).not.toBe(first.run.id);
            expect(second.previous).toEqual(['Train the verified spell.']);
          }),
        );
        yield* restarted((again) =>
          Effect.gen(function* () {
            expect((yield* again.history()).at(-1)?.status).toBe('interrupted');
            expect(yield* again.claim('mage', start + 200000)).toBeNull();
          }),
        );
      }),
    ),
);

test.each([
  { name: 'never-started first', starts: [0, undefined, undefined], order: ['b', 'c', 'a'] },
  { name: 'least recently started', starts: [900000, 700000, 800000], order: ['b', 'c', 'a'] },
  { name: 'stable started ties', starts: [900000, 900000, 900000], order: ['a', 'b', 'c'] },
])('claims use $name without changing eligibility or saved order', ({ starts, order }) =>
  Effect.runPromise(
    withStore((store) =>
      Effect.gen(function* () {
        const now = 1000000;
        const base = {
          ...definition(),
          characterKey: 'mage',
          enabled: true,
          updatedAt: 100000,
          nextAt: 200000,
        };
        const seededRoutines = [
          { ...base, id: 'paused', enabled: false },
          { ...base, id: 'other', characterKey: 'other' },
          { ...base, id: 'not-due', nextAt: now + 1 },
          { ...base, id: 'cooldown', lastStartedAt: now - 1000 },
          ...['a', 'b', 'c'].map((id, index) => ({ ...base, id, lastStartedAt: starts[index] })),
        ].map((routine) => savedRoutine.parse(routine));
        const savedOrder = seededRoutines.map((routine) => routine.id);
        const { root } = yield* TestDirectory;
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, 'routines.json'),
            JSON.stringify({ routines: seededRoutines, runs: [] }),
          ),
        );
        yield* importProductData();
        for (const id of order) {
          const claimed = (yield* store.claim('mage', now))!;
          expect(claimed.routine.id).toBe(id);
          yield* store.finish(claimed.run.id, 'no_tip', '', now);
        }
        expect(yield* store.claim('mage', now)).toBeNull();
        expect((yield* store.list()).map((routine) => routine.id)).toEqual(savedOrder);
        yield* restarted((restored) =>
          Effect.gen(function* () {
            expect((yield* restored.list()).map((routine) => routine.id)).toEqual(savedOrder);
          }),
        );
      }),
    ),
  ),
);
it.live(
  'pause clears pending work; intervals coalesce offline time; once waits for a useful result',
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const start = 1000000;
        const routine = {
          ...definition(),
          triggers: [{ kind: 'interval' as const, seconds: 60 }],
          once: true,
        };
        yield* store.mutate('mage', { operation: 'save', routine }, undefined, start);
        expect(yield* store.claim('mage', start + 59000)).toBeNull();
        yield* store.mutate('mage', { operation: 'pause', id: routine.id }, undefined, start);
        expect(yield* store.claim('mage', start + 500000)).toBeNull();
        yield* store.mutate(
          'mage',
          { operation: 'resume', id: routine.id },
          undefined,
          start + 500000,
        );
        expect(yield* store.claim('mage', start + 500000)).toBeNull();
        const silent = (yield* store.claim('mage', start + 900000))!;
        yield* store.finish(silent.run.id, 'no_tip', '', start + 900001);
        expect((yield* store.list('mage'))[0].enabled).toBe(true);
        const useful = (yield* store.claim('mage', start + 9999999))!;
        yield* store.finish(useful.run.id, 'done', 'Goal reached', start + 10000000);
        expect(yield* store.claim('mage', start + 19999999)).toBeNull();
        expect((yield* store.list('mage'))[0].enabled).toBe(false);
        const missing = yield* Effect.flip(
          store.mutate('other', { operation: 'remove', id: routine.id }),
        );
        expect(missing.message).toContain('not found');
      }),
    ),
);

it.live(
  'dispatch deferred by a new user turn restores the pending one-shot without a phantom run',
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const now = 1000000;
        yield* store.mutate(
          'mage',
          { operation: 'save', routine: { ...definition(), once: true } },
          undefined,
          now,
        );
        yield* store.observe('mage', { event: 'level_up', values: { level: 24 } }, now);
        const claimed = (yield* store.claim('mage', now + 1))!;
        yield* store.defer(claimed.run.id, claimed.event);
        expect(yield* store.history()).toHaveLength(0);
        expect((yield* store.list('mage'))[0].enabled).toBe(true);
        expect(yield* store.claim('mage', now + 2)).not.toBeNull();
      }),
    ),
);

it.live('overdue routines alternate when each run outlasts its interval and cooldown', () =>
  withStore((store) =>
    Effect.gen(function* () {
      const start = 1000000;
      for (const id of ['a', 'b']) {
        yield* store.mutate(
          'mage',
          {
            operation: 'save',
            routine: {
              ...definition(),
              id,
              triggers: [{ kind: 'interval', seconds: 60 }],
            },
          },
          undefined,
          start,
        );
      }
      const selected: string[] = [];
      for (let round = 0; round < 4; round++) {
        const now = start + 60000 + round * 65000;
        const claimed = (yield* store.claim('mage', now))!;
        selected.push(claimed.routine.id);
        yield* store.finish(claimed.run.id, 'no_tip', '', now + 65000);
      }
      expect(selected).toEqual(['a', 'b', 'a', 'b']);
      expect((yield* store.list('mage')).map((routine) => routine.id)).toEqual(['a', 'b']);
    }),
  ),
);
