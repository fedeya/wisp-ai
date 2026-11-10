import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RoutineStore } from '../src/routines.ts';
import { routineDefinition } from '@wisp/protocol/routines';
import { databaseScope } from './database-fixture.ts';

test('routine polling and mutations stay bounded with a large silent-run history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-large-routine-history-'));
  const scope = databaseScope();
  const database = scope.open(path.join(root, 'wisp.sqlite'));
  const store = new RoutineStore(database);
  try {
    await store.load();
    const definition = routineDefinition.parse({
      id: 'review',
      title: 'Review',
      instruction: 'Review spells',
      triggers: [{ kind: 'interval', seconds: 60 }],
      cooldownSeconds: 60,
    });
    await store.mutate('mage', { operation: 'save', routine: definition }, undefined, 100000);
    const client = database.connection;
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
    const prepare = client.prepare.bind(client);
    const queries: string[] = [];
    client.prepare = (query) => {
      queries.push(query);
      return prepare(query);
    };
    expect(await store.claim('mage', 100001)).toBeNull();
    expect(queries.some((query) => /from "routine_runs"/i.test(query))).toBe(false);
    queries.length = 0;
    const claimed = (await store.claim('mage', 200000))!;
    expect(claimed.previous).toEqual(['Summary 5', 'Summary 100', 'Summary 1000']);
    await store.finish(claimed.run.id, 'done', 'New summary', 200001);
    expect(
      store
        .history({ characterKey: 'mage', routineId: 'review', includeSilent: false, limit: 2 })
        .map((run) => run.summary),
    ).toEqual(['Summary 1000', 'New summary']);
    expect(store.getRun('old-3')!.status).toBe('no_tip');
    const historyReads = queries.filter((query) => /select .*from "routine_runs"/i.test(query));
    expect(historyReads.length).toBeGreaterThan(0);
    expect(historyReads.every((query) => /where|limit|max\(/i.test(query))).toBe(true);
    // Neither ordering a new run nor looking up previous recommendations sorts the full history.
    const plans = [
      'EXPLAIN QUERY PLAN SELECT max(sort_index) FROM routine_runs',
      "EXPLAIN QUERY PLAN SELECT summary FROM routine_runs WHERE character_key='mage' AND routine_id='review' AND status='done' ORDER BY sort_index DESC LIMIT 3",
      "EXPLAIN QUERY PLAN SELECT id FROM routine_runs WHERE character_key='mage' AND status <> 'no_tip' ORDER BY sort_index DESC LIMIT 50",
    ].flatMap((query) =>
      prepare(query)
        .all()
        .map((row) => String(row.detail)),
    );
    expect(plans.every((plan) => !plan.includes('TEMP B-TREE'))).toBe(true);
    expect(plans.every((plan) => plan.includes('INDEX'))).toBe(true);
    expect(client.prepare("SELECT extras FROM routine_runs WHERE id='old-3'").get()!.extras).toBe(
      '{"keep":true}',
    );
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
