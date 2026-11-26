import { expect } from 'vitest';
import { it } from '@effect/vitest';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { routineDefinition } from '@wisp/protocol/routines';
import { testStorage, TestDirectory } from './storage-fixture.ts';

it.live('routine polling and mutations stay bounded with a large silent-run history', () =>
  Effect.gen(function* () {
    const store = yield* RoutineStore;
    const { file } = yield* TestDirectory;
    // A second connection writes the old history in bulk and reads query plans.
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (client) => Effect.sync(() => client.close()),
    );
    const definition = routineDefinition.parse({
      id: 'review',
      title: 'Review',
      instruction: 'Review spells',
      triggers: [{ kind: 'interval', seconds: 60 }],
      cooldownSeconds: 60,
    });
    yield* store.mutate('mage', { operation: 'save', routine: definition }, undefined, 100000);
    client.exec('BEGIN IMMEDIATE');
    const insert = client.prepare(
      'INSERT INTO routine_runs(id,character_key,routine_id,sort_index,title,started_at,finished_at,event,status,summary,extras) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (let i = 0; i < 25000; i++) {
      insert.run(
        'old-' + i,
        'mage',
        'review',
        i,
        'Old run',
        i,
        i + 1,
        'interval',
        [5, 100, 1000].includes(i) ? 'done' : 'no_tip',
        'Summary ' + i,
        '{"keep":true}',
      );
    }
    client.exec('COMMIT');
    expect(yield* store.claim('mage', 100001)).toBeNull();
    const claimed = (yield* store.claim('mage', 200000))!;
    expect(claimed.previous).toEqual(['Summary 5', 'Summary 100', 'Summary 1000']);
    yield* store.finish(claimed.run.id, 'done', 'New summary', 200001);
    const history = yield* store.history({
      characterKey: 'mage',
      routineId: 'review',
      includeSilent: false,
      limit: 2,
    });
    expect(history.map((run) => run.summary)).toEqual(['Summary 1000', 'New summary']);
    expect((yield* store.getRun('old-3'))!.status).toBe('no_tip');
    // Neither ordering a new run nor looking up previous recommendations sorts the full history.
    const plans = [
      'EXPLAIN QUERY PLAN SELECT max(sort_index) FROM routine_runs',
      "EXPLAIN QUERY PLAN SELECT summary FROM routine_runs WHERE character_key='mage' AND routine_id='review' AND status='done' ORDER BY sort_index DESC LIMIT 3",
      "EXPLAIN QUERY PLAN SELECT id FROM routine_runs WHERE character_key='mage' AND status <> 'no_tip' ORDER BY sort_index DESC LIMIT 50",
    ].flatMap((query) =>
      client
        .prepare(query)
        .all()
        .map((row) => String(row.detail)),
    );
    expect(plans.every((plan) => !plan.includes('TEMP B-TREE'))).toBe(true);
    expect(plans.every((plan) => plan.includes('INDEX'))).toBe(true);
    expect(client.prepare("SELECT extras FROM routine_runs WHERE id='old-3'").get()!.extras).toBe(
      '{"keep":true}',
    );
  }).pipe(Effect.scoped, Effect.provide(testStorage())),
);
