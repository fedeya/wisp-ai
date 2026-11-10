import { test, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RoutineStore } from '../src/routines.ts';
import { databaseScope } from './database-fixture.ts';
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
async function fixture(
  work: (store: RoutineStore, file: string, openStore: () => RoutineStore) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-routines-'));
  const scope = databaseScope();
  try {
    const file = path.join(root, 'wisp.sqlite');
    const openStore = () => new RoutineStore(scope.open(file));
    await work(openStore(), file, openStore);
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
}
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
test('pending events survive restart, coalesce, respect cooldown and stay character scoped', async () =>
  fixture(async (store, file, openStore) => {
    const start = 1000000;
    await store.mutate(
      'mage',
      { operation: 'save', routine: definition() },
      'creation-chat',
      start,
    );
    await store.observe('other', { event: 'level_up', values: { level: 24 } }, start);
    expect(await store.claim('mage', start)).toBeNull();
    await store.observe('mage', { event: 'level_up', values: { level: 24 } }, start);
    await store.observe('mage', { event: 'level_up', values: { level: 26 } }, start + 1);
    const restored = openStore();
    await restored.load();
    const claims = await Promise.all([
      restored.claim('mage', start + 2),
      restored.claim('mage', start + 2),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    expect(first.event.values.level).toBe(26);
    expect(first.routine.sourceChatId).toBe('creation-chat');
    await restored.finish(first.run.id, 'done', 'Train the verified spell.', start + 3);
    await restored.observe('mage', { event: 'level_up', values: { level: 28 } }, start + 4);
    expect(await restored.claim('mage', start + 1000)).toBeNull();
    const second = (await restored.claim('mage', start + 60002))!;
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.previous).toEqual(['Train the verified spell.']);
    const again = openStore();
    await again.load();
    expect(again.history().at(-1)?.status).toBe('interrupted');
    expect(await again.claim('mage', start + 200000)).toBeNull();
  }));

test.each([
  { name: 'never-started first', starts: [0, undefined, undefined], order: ['b', 'c', 'a'] },
  { name: 'least recently started', starts: [900000, 700000, 800000], order: ['b', 'c', 'a'] },
  { name: 'stable started ties', starts: [900000, 900000, 900000], order: ['a', 'b', 'c'] },
])('claims use $name without changing eligibility or saved order', async ({ starts, order }) =>
  fixture(async (store, file, openStore) => {
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
    await writeFile(
      path.join(path.dirname(file), 'routines.json'),
      JSON.stringify({ routines: seededRoutines, runs: [] }),
    );
    for (const id of order) {
      const claimed = (await store.claim('mage', now))!;
      expect(claimed.routine.id).toBe(id);
      await store.finish(claimed.run.id, 'no_tip', '', now);
    }
    expect(await store.claim('mage', now)).toBeNull();
    expect(store.list().map((routine) => routine.id)).toEqual(savedOrder);
    const restored = openStore();
    await restored.load();
    expect(restored.list().map((routine) => routine.id)).toEqual(savedOrder);
  }),
);
test('pause clears pending work; intervals coalesce offline time; once waits for a useful result', async () =>
  fixture(async (store) => {
    const start = 1000000;
    const routine = {
      ...definition(),
      triggers: [{ kind: 'interval' as const, seconds: 60 }],
      once: true,
    };
    await store.mutate('mage', { operation: 'save', routine }, undefined, start);
    expect(await store.claim('mage', start + 59000)).toBeNull();
    await store.mutate('mage', { operation: 'pause', id: routine.id }, undefined, start);
    expect(await store.claim('mage', start + 500000)).toBeNull();
    await store.mutate('mage', { operation: 'resume', id: routine.id }, undefined, start + 500000);
    expect(await store.claim('mage', start + 500000)).toBeNull();
    const silent = (await store.claim('mage', start + 900000))!;
    await store.finish(silent.run.id, 'no_tip', '', start + 900001);
    expect(store.list('mage')[0].enabled).toBe(true);
    const useful = (await store.claim('mage', start + 9999999))!;
    await store.finish(useful.run.id, 'done', 'Goal reached', start + 10000000);
    expect(await store.claim('mage', start + 19999999)).toBeNull();
    expect(store.list('mage')[0].enabled).toBe(false);
    await expect(store.mutate('other', { operation: 'remove', id: routine.id })).rejects.toThrow(
      'not found',
    );
  }));

test('dispatch deferred by a new user turn restores the pending one-shot without a phantom run', async () =>
  fixture(async (store) => {
    const now = 1000000;
    await store.mutate(
      'mage',
      { operation: 'save', routine: { ...definition(), once: true } },
      undefined,
      now,
    );
    await store.observe('mage', { event: 'level_up', values: { level: 24 } }, now);
    const claimed = (await store.claim('mage', now + 1))!;
    await store.defer(claimed.run.id, claimed.event);
    expect(store.history()).toHaveLength(0);
    expect(store.list('mage')[0].enabled).toBe(true);
    expect(await store.claim('mage', now + 2)).not.toBeNull();
  }));

test('overdue routines alternate when each run outlasts its interval and cooldown', async () =>
  fixture(async (store) => {
    const start = 1000000;
    for (const id of ['a', 'b']) {
      await store.mutate(
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
      const claimed = (await store.claim('mage', now))!;
      selected.push(claimed.routine.id);
      await store.finish(claimed.run.id, 'no_tip', '', now + 65000);
    }
    expect(selected).toEqual(['a', 'b', 'a', 'b']);
    expect(store.list('mage').map((routine) => routine.id)).toEqual(['a', 'b']);
  }));
