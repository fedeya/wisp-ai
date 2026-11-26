import { test, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { inspect as describe, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import type { SqlDatabase } from '@wisp/db/sql-database';
import { importProductData } from '../src/migrations/product-json.ts';
import { databaseScope, chatStoreAt, promised } from './database-fixture.ts';
import { makeRoutineStore } from '../src/routines/routine-store.ts';
import { makePanelStore } from '../src/panels/panel-store.ts';
import { makeMemoryStore } from '../src/agent/memory-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { savedRoutine } from '@wisp/protocol/routines';

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
type Opened = SqlDatabase['Service'] & { initializeProducts: () => Promise<void> };
async function fixture(
  work: (
    root: string,
    file: string,
    openDb: (file: string) => Promise<Opened>,
    ready: (file: string) => Promise<Opened>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-product-storage-'));
  const scope = databaseScope();
  const openDb = async (file: string): Promise<Opened> => {
    const database = await scope.open(file);
    return {
      ...database,
      initializeProducts: () => Effect.runPromise(importProductData(file, database.db)),
    };
  };
  // What startup does: open the database, then import the legacy JSON once.
  const ready = async (file: string) => {
    const database = await openDb(file);
    await database.initializeProducts();
    return database;
  };
  try {
    await work(root, path.join(root, 'wisp.sqlite'), openDb, ready);
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
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

test('imports all product data into the same database as chats, retaining exact sources, backups and extensions', async () =>
  fixture(async (root, file, openDb, ready) => {
    const sources = await legacy(root);
    const chat = {
      ...newChat('history', 'game'),
      messages: [{ role: 'user', text: 'Keep conversation' }],
    };
    await writeFile(path.join(root, 'chats.json'), JSON.stringify([chat]));
    const chats = chatStoreAt(file, () => {});
    try {
      expect((await chats.load())[0].messages).toEqual(chat.messages);
    } finally {
      await chats.close();
    }
    await (await openDb(file)).initializeProducts();
    const routines = promised(makeRoutineStore(await ready(file)));
    const panels = promised(makePanelStore(await ready(file)));
    expect(await routines.list()).toEqual([routine]);
    expect(await routines.history()).toEqual([run]);
    expect(await panels.all()).toEqual([panel]);
    expect(await promised(makeMemoryStore(await ready(file))).read('character', 'mage')).toEqual(
      memory.entries,
    );
    for (const [name, original] of sources) {
      const originalFile = path.join(root, name);
      expect(await readFile(originalFile, 'utf8')).toBe(original);
      const digest = createHash('sha256').update(original).digest('hex');
      expect(
        await readFile(originalFile.replace(/\.json$/, `.pre-sqlite-${digest}.json`), 'utf8'),
      ).toBe(original);
    }
    inspect(file, (db) => {
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        JSON.parse(String(db.prepare('SELECT extras FROM memory_scopes').get()!.extras)),
      ).toEqual({ extension: memory.extension });
      expect(
        JSON.parse(
          String(
            db.prepare("SELECT value FROM metadata WHERE key='product-json-import-v1'").get()!
              .value,
          ),
        ).routineExtensions,
      ).toEqual({ extension: 'keep' });
    });
  }));

test.each(['null', '{invalid', '[{}]'])(
  'invalid panels %s stop the whole import and retry succeeds after repair',
  async (invalid) =>
    fixture(async (root, file, openDb, ready) => {
      await legacy(root);
      await writeFile(path.join(root, 'panels.json'), invalid);
      const database = await openDb(file);
      await expect(database.initializeProducts()).rejects.toThrow();
      inspect(file, (db) => {
        expect(db.prepare('SELECT count(*) AS n FROM routines').get()!.n).toBe(0);
        expect(
          db.prepare("SELECT value FROM metadata WHERE key='product-json-import-v1'").get(),
        ).toBeUndefined();
      });
      expect(await readFile(path.join(root, 'panels.json'), 'utf8')).toBe(invalid);
      await writeFile(path.join(root, 'panels.json'), JSON.stringify([panel]));
      await database.initializeProducts();
      expect(await promised(makeMemoryStore(await ready(file))).read('character', 'mage')).toEqual(
        memory.entries,
      );
    }),
);

test.each(['routines', 'runs', 'memory'])(
  'duplicate %s identities roll back all imported domains',
  async (domain) =>
    fixture(async (root, file, openDb, ready) => {
      await legacy(root);
      if (domain === 'memory') {
        await writeFile(
          path.join(root, 'memory', memoryName),
          JSON.stringify({ ...memory, entries: [...memory.entries, ...memory.entries] }),
        );
      } else {
        await writeFile(
          path.join(root, 'routines.json'),
          JSON.stringify({
            routines: domain === 'routines' ? [routine, routine] : [routine],
            runs: domain === 'runs' ? [run, run] : [run],
          }),
        );
      }
      await expect((await openDb(file)).initializeProducts()).rejects.toThrow('Duplicate');
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
);

test('memory ownership mismatches fail closed; a conflicting backup is never overwritten', async () =>
  fixture(async (root, file, openDb, ready) => {
    const sources = await legacy(root);
    await writeFile(
      path.join(root, 'memory', memoryName),
      JSON.stringify({ ...memory, owner: 'other' }),
    );
    await expect((await openDb(file)).initializeProducts()).rejects.toThrow('identity');
    await writeFile(
      path.join(root, 'memory', memoryName),
      sources.get(path.join('memory', memoryName))!,
    );
    const original = sources.get('routines.json')!;
    const digest = createHash('sha256').update(original).digest('hex');
    const backup = path.join(root, `routines.pre-sqlite-${digest}.json`);
    await writeFile(backup, 'unrelated backup');
    await expect((await openDb(file)).initializeProducts()).rejects.toThrow();
    expect(await readFile(backup, 'utf8')).toBe('unrelated backup');
  }));

test('deletions remain authoritative after restart even when legacy files are stale or invalid', async () =>
  fixture(async (root, file, openDb, ready) => {
    await legacy(root);
    const routines = promised(makeRoutineStore(await ready(file)));
    await routines.mutate('mage', { operation: 'remove', id: routine.id });
    const panels = promised(makePanelStore(await ready(file)));
    await panels.mutate('mage', { operation: 'remove', id: panel.id });
    await promised(makeMemoryStore(await ready(file))).update('character', 'mage', 'guide');
    await writeFile(path.join(root, 'routines.json'), 'invalid stale JSON');
    await writeFile(path.join(root, 'memory', memoryName), 'invalid stale JSON');
    const reopened = promised(makeRoutineStore(await ready(file)));
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.history()).toEqual([run]);
    const reopenedPanels = promised(makePanelStore(await ready(file)));
    expect(await reopenedPanels.all()).toEqual([]);
    expect(await promised(makeMemoryStore(await ready(file))).read('character', 'mage')).toEqual(
      [],
    );
  }));

test('independent stores preserve concurrent edits and a routine can only be claimed once', async () =>
  fixture(async (_root, file, openDb, ready) => {
    const first = promised(makeRoutineStore(await ready(file))),
      second = promised(makeRoutineStore(await ready(file)));
    await Promise.all([
      first.mutate('mage', { operation: 'save', routine }, undefined, 0),
      second.mutate('warrior', { operation: 'save', routine }, undefined, 0),
    ]);
    const claims = await Promise.all([first.claim('mage', 1000000), second.claim('mage', 1000000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await second.list()).toHaveLength(2);
    const p1 = promised(makePanelStore(await ready(file))),
      p2 = promised(makePanelStore(await ready(file)));
    await Promise.all([
      p1.mutate('mage', { operation: 'save', panel }),
      p2.mutate('warrior', { operation: 'save', panel }),
    ]);
    expect(await p1.all()).toHaveLength(2);
    const m1 = promised(makeMemoryStore(await ready(file))),
      m2 = promised(makeMemoryStore(await ready(file)));
    await Promise.all([
      m1.update('character', 'mage', 'one', 'first'),
      m2.update('character', 'mage', 'two', 'second'),
    ]);
    expect((await m1.read('character', 'mage')).map((entry) => entry.key).sort()).toEqual([
      'one',
      'two',
    ]);
  }));

test("three processes import once and update memory without losing each other's entries", async () =>
  fixture(async (root, file, openDb, ready) => {
    const sources = await legacy(root);
    const source = `import { Effect } from 'effect';
    import * as Sql from '@wisp/db/sql-database';
    import { makeMemoryStore } from '@wisp/server/memory-store';
    import { importProductData } from '@wisp/server/product-json';
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Sql.make(process.argv[1]);
      yield* importProductData(process.argv[1], database.db);
      yield* makeMemoryStore(database).update('character', 'mage', process.argv[2], 'Concurrent entry');
    })));`;
    const settled = await Promise.allSettled(
      ['one', 'two', 'three'].map((key) =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, file, key], {
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          windowsHide: true,
        }),
      ),
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    expect(
      (await promised(makeMemoryStore(await ready(file))).read('character', 'mage'))
        .map((entry) => entry.key)
        .sort(),
    ).toEqual(['guide', 'one', 'three', 'two']);
    inspect(file, (db) =>
      expect(db.prepare('SELECT count(*) AS n FROM routine_runs').get()!.n).toBe(1),
    );
    for (const [name, original] of sources) {
      const digest = createHash('sha256').update(original).digest('hex');
      const backup = path.join(root, name.replace(/\.json$/, `.pre-sqlite-${digest}.json`));
      expect(await readFile(backup, 'utf8')).toBe(original);
      const prefix = path.basename(name, '.json') + '.pre-sqlite-';
      expect(
        (await readdir(path.dirname(backup))).filter((entry) => entry.startsWith(prefix)),
      ).toEqual([path.basename(backup)]);
    }
  }));

test('a failed SQL mutation rolls back records and the next valid mutation still works', async () =>
  fixture(async (_root, file, openDb, ready) => {
    const routines = promised(makeRoutineStore(await ready(file)));
    await routines.mutate('mage', { operation: 'save', routine }, undefined, 0);
    inspect(file, (db) =>
      db.exec(
        "CREATE TRIGGER reject_run BEFORE INSERT ON routine_runs BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END",
      ),
    );
    const failure: unknown = await routines.claim('mage', 1000000).catch((error: unknown) => error);
    expect(describe(failure, { depth: 10 })).toContain('disk write rejected');
    inspect(file, (db) => {
      expect(db.prepare('SELECT count(*) AS n FROM routine_runs').get()!.n).toBe(0);
      expect(db.prepare('SELECT next_at FROM routines').get()!.next_at).toBe(60000);
      db.exec('DROP TRIGGER reject_run');
    });
    expect(await routines.claim('mage', 1000000)).not.toBeNull();
  }));
