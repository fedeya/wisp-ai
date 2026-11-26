import { expect } from 'vitest';
import { it } from '@effect/vitest';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { importProductData } from '../src/migrations/product-json.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { PanelStore } from '../src/panels/panel-store.ts';
import { MemoryStore } from '../src/agent/memory-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { savedRoutine } from '@wisp/protocol/routines';
import { chatsAt, reopen, testDirectory, TestDirectory } from './storage-fixture.ts';

const routine = savedRoutine.parse({
  id: 'review',
  title: 'Review',
  instruction: 'Review spells',
  triggers: [{ kind: 'interval', seconds: 60 }],
  characterKey: 'mage',
  enabled: true,
  updatedAt: 1.5,
  nextAt: 100,
  pending: { event: 'level_up', values: { level: 20 }, at: 2 },
});
const panel = {
  id: 'goal',
  characterKey: 'mage',
  title: 'Goal',
  updatedAt: 2.5,
  ui: [{ id: 'card', kind: 'card' as const, title: 'Goal' }],
  references: {},
  bindings: [],
};
const run = {
  id: 'run-1',
  routineId: 'deleted-routine',
  characterKey: 'mage',
  title: 'Old routine',
  startedAt: 10.5,
  finishedAt: 11.5,
  event: 'interval',
  status: 'done',
  summary: 'Keep 🧙',
  extension: { nested: [1, false, null] },
};
const memory = {
  slot: 'character',
  owner: 'mage',
  entries: [
    { key: 'guide', text: 'Keep this plan 🧙', updatedAt: '2026-11-09', extension: { a: 1 } },
  ],
  extension: [false, null],
};
const memoryName =
  createHash('sha256')
    .update(JSON.stringify([memory.slot, memory.owner]))
    .digest('hex') + '.json';
async function legacy(root: string) {
  await mkdir(path.join(root, 'memory'));
  const sources = new Map([
    [
      'routines.json',
      JSON.stringify({ routines: [routine], runs: [run], extension: 'keep' }, null, 2),
    ],
    ['panels.json', JSON.stringify([panel], null, 2)],
    [path.join('memory', memoryName), JSON.stringify(memory, null, 2)],
  ]);
  for (const [name, content] of sources) {
    await writeFile(path.join(root, name), content);
  }
  return sources;
}
function inspect<T>(file: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** A test with its own directory; the stores open on demand, one connection per startup. */
const inDirectory = <A, E, R>(work: (dir: TestDirectory['Service']) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* work(yield* TestDirectory);
  }).pipe(Effect.scoped, Effect.provide(testDirectory));

/** What startup does on a new connection: import the legacy JSON once, then serve the stores. */
const startup = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  reopen(importProductData().pipe(Effect.andThen(work)));

const importOnly = reopen(importProductData());

const readMemory = Effect.flatMap(MemoryStore, (memories) => memories.read('character', 'mage'));

const files = {
  write: (file: string, content: string) => Effect.promise(() => writeFile(file, content)),
  read: (file: string) => Effect.promise(() => readFile(file, 'utf8')),
};

it.live(
  'imports all product data into the same database as chats, retaining exact sources, backups and extensions',
  () =>
    inDirectory(({ root, file }) =>
      Effect.gen(function* () {
        const sources = yield* Effect.promise(() => legacy(root));
        const chat = {
          ...newChat('history', 'game'),
          messages: [{ role: 'user', text: 'Keep conversation' }],
        };
        yield* files.write(path.join(root, 'chats.json'), JSON.stringify([chat]));
        const chats = yield* chatsAt(file);
        expect((yield* chats.load())[0].messages).toEqual(chat.messages);
        yield* chats.close();
        yield* startup(
          Effect.gen(function* () {
            const routines = yield* RoutineStore;
            expect(yield* routines.list()).toEqual([routine]);
            expect(yield* routines.history()).toEqual([run]);
            expect(yield* (yield* PanelStore).all()).toEqual([panel]);
            expect(yield* readMemory).toEqual(memory.entries);
          }),
        );
        for (const [name, original] of sources) {
          const originalFile = path.join(root, name);
          expect(yield* files.read(originalFile)).toBe(original);
          const digest = createHash('sha256').update(original).digest('hex');
          const backup = originalFile.replace(/\.json$/, `.pre-sqlite-${digest}.json`);
          expect(yield* files.read(backup)).toBe(original);
        }
        inspect(file, (db) => {
          expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          expect(
            JSON.parse(String(db.prepare('SELECT extras FROM memory_scopes').get()!.extras)),
          ).toEqual({ extension: memory.extension });
          const marker = db
            .prepare("SELECT value FROM metadata WHERE key='product-json-import-v1'")
            .get()!;
          expect(JSON.parse(String(marker.value)).routineExtensions).toEqual({
            extension: 'keep',
          });
        });
      }),
    ),
);

it.live.each(['null', '{invalid', '[{}]'])(
  'invalid panels %s stop the whole import and retry succeeds after repair',
  (invalid) =>
    inDirectory(({ root, file }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => legacy(root));
        yield* files.write(path.join(root, 'panels.json'), invalid);
        yield* Effect.flip(importOnly);
        inspect(file, (db) => {
          expect(db.prepare('SELECT count(*) AS n FROM routines').get()!.n).toBe(0);
          expect(
            db.prepare("SELECT value FROM metadata WHERE key='product-json-import-v1'").get(),
          ).toBeUndefined();
        });
        expect(yield* files.read(path.join(root, 'panels.json'))).toBe(invalid);
        yield* files.write(path.join(root, 'panels.json'), JSON.stringify([panel]));
        expect(yield* startup(readMemory)).toEqual(memory.entries);
      }),
    ),
);

it.live.each(['routines', 'runs', 'memory'])(
  'duplicate %s identities roll back all imported domains',
  (domain) =>
    inDirectory(({ root, file }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => legacy(root));
        if (domain === 'memory') {
          yield* files.write(
            path.join(root, 'memory', memoryName),
            JSON.stringify({ ...memory, entries: [...memory.entries, ...memory.entries] }),
          );
        } else {
          yield* files.write(
            path.join(root, 'routines.json'),
            JSON.stringify({
              routines: domain === 'routines' ? [routine, routine] : [routine],
              runs: domain === 'runs' ? [run, run] : [run],
            }),
          );
        }
        expect((yield* Effect.flip(importOnly)).message).toContain('Duplicate');
        inspect(file, (db) => {
          for (const table of [
            'routines',
            'routine_runs',
            'panels',
            'memory_entries',
            'memory_scopes',
          ]) {
            expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
          }
        });
      }),
    ),
);

it.live('memory ownership mismatches fail closed; a conflicting backup is never overwritten', () =>
  inDirectory(({ root }) =>
    Effect.gen(function* () {
      const sources = yield* Effect.promise(() => legacy(root));
      const memoryFile = path.join(root, 'memory', memoryName);
      yield* files.write(memoryFile, JSON.stringify({ ...memory, owner: 'other' }));
      expect((yield* Effect.flip(importOnly)).message).toContain('identity');
      yield* files.write(memoryFile, sources.get(path.join('memory', memoryName))!);
      const original = sources.get('routines.json')!;
      const digest = createHash('sha256').update(original).digest('hex');
      const backup = path.join(root, `routines.pre-sqlite-${digest}.json`);
      yield* files.write(backup, 'unrelated backup');
      yield* Effect.flip(importOnly);
      expect(yield* files.read(backup)).toBe('unrelated backup');
    }),
  ),
);

it.live(
  'deletions remain authoritative after restart even when legacy files are stale or invalid',
  () =>
    inDirectory(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => legacy(root));
        yield* startup(
          Effect.gen(function* () {
            yield* (yield* RoutineStore).mutate('mage', { operation: 'remove', id: routine.id });
            yield* (yield* PanelStore).mutate('mage', { operation: 'remove', id: panel.id });
            yield* (yield* MemoryStore).update('character', 'mage', 'guide');
          }),
        );
        yield* files.write(path.join(root, 'routines.json'), 'invalid stale JSON');
        yield* files.write(path.join(root, 'memory', memoryName), 'invalid stale JSON');
        yield* startup(
          Effect.gen(function* () {
            const routines = yield* RoutineStore;
            expect(yield* routines.list()).toEqual([]);
            expect(yield* routines.history()).toEqual([run]);
            expect(yield* (yield* PanelStore).all()).toEqual([]);
            expect(yield* readMemory).toEqual([]);
          }),
        );
      }),
    ),
);

it.live('independent stores preserve concurrent edits and a routine can only be claimed once', () =>
  inDirectory(() =>
    Effect.gen(function* () {
      // Each startup is its own connection, as two bridges sharing one file would have.
      const concurrently = <A, E, R>(effects: Effect.Effect<A, E, R>[]) =>
        Effect.all(effects, { concurrency: 'unbounded' });
      const routines = <A, E>(work: (store: RoutineStore['Service']) => Effect.Effect<A, E>) =>
        startup(Effect.flatMap(RoutineStore, work));
      const panels = <A, E>(work: (store: PanelStore['Service']) => Effect.Effect<A, E>) =>
        startup(Effect.flatMap(PanelStore, work));
      const memories = <A, E>(work: (store: MemoryStore['Service']) => Effect.Effect<A, E>) =>
        startup(Effect.flatMap(MemoryStore, work));

      yield* concurrently([
        routines((store) => store.mutate('mage', { operation: 'save', routine }, undefined, 0)),
        routines((store) => store.mutate('warrior', { operation: 'save', routine }, undefined, 0)),
      ]);
      const claims = yield* concurrently([
        routines((store) => store.claim('mage', 1000000)),
        routines((store) => store.claim('mage', 1000000)),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(yield* routines((store) => store.list())).toHaveLength(2);
      yield* concurrently([
        panels((store) => store.mutate('mage', { operation: 'save', panel })),
        panels((store) => store.mutate('warrior', { operation: 'save', panel })),
      ]);
      expect(yield* panels((store) => store.all())).toHaveLength(2);
      yield* concurrently([
        memories((store) => store.update('character', 'mage', 'one', 'first')),
        memories((store) => store.update('character', 'mage', 'two', 'second')),
      ]);
      const keys = (yield* startup(readMemory)).map((entry) => entry.key).sort();
      expect(keys).toEqual(['one', 'two']);
    }),
  ),
);

it.live("three processes import once and update memory without losing each other's entries", () =>
  inDirectory(({ root, file }) =>
    Effect.gen(function* () {
      const sources = yield* Effect.promise(() => legacy(root));
      const source = `import { Effect, Layer } from 'effect';
    import * as Sql from '@wisp/db/sql-database';
    import * as Memories from '@wisp/server/memory-store';
    import { importProductData } from '@wisp/server/product-json';
    const storage = Memories.layer.pipe(Layer.provideMerge(Sql.layer(process.argv[1])));
    await Effect.runPromise(Effect.gen(function* () {
      yield* importProductData();
      const memories = yield* Memories.MemoryStore;
      yield* memories.update('character', 'mage', process.argv[2], 'Concurrent entry');
    }).pipe(Effect.provide(storage)));`;
      yield* Effect.promise(async () => {
        const settled = await Promise.allSettled(
          ['one', 'two', 'three'].map((key) =>
            promisify(execFile)(
              process.execPath,
              ['--input-type=module', '-e', source, file, key],
              {
                cwd: fileURLToPath(new URL('.', import.meta.url)),
                windowsHide: true,
              },
            ),
          ),
        );
        for (const result of settled) {
          if (result.status === 'rejected') {
            throw result.reason;
          }
        }
      });
      const keys = (yield* startup(readMemory)).map((entry) => entry.key).sort();
      expect(keys).toEqual(['guide', 'one', 'three', 'two']);
      inspect(file, (db) =>
        expect(db.prepare('SELECT count(*) AS n FROM routine_runs').get()!.n).toBe(1),
      );
      for (const [name, original] of sources) {
        const digest = createHash('sha256').update(original).digest('hex');
        const backup = path.join(root, name.replace(/\.json$/, `.pre-sqlite-${digest}.json`));
        expect(yield* files.read(backup)).toBe(original);
        const prefix = path.basename(name, '.json') + '.pre-sqlite-';
        const entries = yield* Effect.promise(() => readdir(path.dirname(backup)));
        expect(entries.filter((entry) => entry.startsWith(prefix))).toEqual([
          path.basename(backup),
        ]);
      }
    }),
  ),
);

it.live('a failed SQL mutation rolls back records and the next valid mutation still works', () =>
  inDirectory(({ file }) =>
    startup(
      Effect.gen(function* () {
        const routines = yield* RoutineStore;
        yield* routines.mutate('mage', { operation: 'save', routine }, undefined, 0);
        inspect(file, (db) =>
          db.exec(
            "CREATE TRIGGER reject_run BEFORE INSERT ON routine_runs BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END",
          ),
        );
        const failure = yield* Effect.flip(routines.claim('mage', 1000000));
        expect(failure.reason._tag).toBe('DatabaseFailure');
        expect(failure.message).toContain('disk write rejected');
        inspect(file, (db) => {
          expect(db.prepare('SELECT count(*) AS n FROM routine_runs').get()!.n).toBe(0);
          expect(db.prepare('SELECT next_at FROM routines').get()!.next_at).toBe(60000);
          db.exec('DROP TRIGGER reject_run');
        });
        expect(yield* routines.claim('mage', 1000000)).not.toBeNull();
      }),
    ),
  ),
);
