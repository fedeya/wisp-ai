import { test, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ApplicationDatabase } from '../src/application-database.ts';
import { databaseScope } from './database-fixture.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { PanelStore } from '../src/panels/panel-store.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
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
async function fixture(
  work: (
    root: string,
    file: string,
    openDb: (file: string) => ApplicationDatabase,
    openMemory: ReturnType<typeof databaseScope>['memory'],
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-product-storage-'));
  const scope = databaseScope();
  try {
    await work(root, path.join(root, 'wisp.sqlite'), scope.open, scope.memory);
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
  fixture(async (root, file, openDb, openMemory) => {
    const sources = await legacy(root);
    const chat = {
      ...newChat('history', 'game'),
      messages: [{ role: 'user', text: 'Keep conversation' }],
    };
    await writeFile(path.join(root, 'chats.json'), JSON.stringify([chat]));
    const chats = new ChatStore(file, () => {});
    try {
      expect((await chats.load())[0].messages).toEqual(chat.messages);
    } finally {
      await chats.close();
    }
    await openDb(file).initializeProducts();
    const routines = new RoutineStore(openDb(file));
    await routines.load();
    const panels = new PanelStore(openDb(file));
    await panels.load();
    expect(routines.list()).toEqual([routine]);
    expect(routines.history()).toEqual([run]);
    expect(panels.panels).toEqual([panel]);
    expect(await openMemory(openDb(file)).read('character', 'mage')).toEqual(memory.entries);
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
    fixture(async (root, file, openDb, openMemory) => {
      await legacy(root);
      await writeFile(path.join(root, 'panels.json'), invalid);
      const database = openDb(file);
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
      expect(await openMemory(database).read('character', 'mage')).toEqual(memory.entries);
    }),
);

test.each(['routines', 'runs', 'memory'])(
  'duplicate %s identities roll back all imported domains',
  async (domain) =>
    fixture(async (root, file, openDb) => {
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
      await expect(openDb(file).initializeProducts()).rejects.toThrow('Duplicate');
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
  fixture(async (root, file, openDb) => {
    const sources = await legacy(root);
    await writeFile(
      path.join(root, 'memory', memoryName),
      JSON.stringify({ ...memory, owner: 'other' }),
    );
    await expect(openDb(file).initializeProducts()).rejects.toThrow('identity');
    await writeFile(
      path.join(root, 'memory', memoryName),
      sources.get(path.join('memory', memoryName))!,
    );
    const original = sources.get('routines.json')!;
    const digest = createHash('sha256').update(original).digest('hex');
    const backup = path.join(root, `routines.pre-sqlite-${digest}.json`);
    await writeFile(backup, 'unrelated backup');
    await expect(openDb(file).initializeProducts()).rejects.toThrow();
    expect(await readFile(backup, 'utf8')).toBe('unrelated backup');
  }));

test('a failed memory insert rolls back the product import and leaves it retryable', async () =>
  fixture(async (root, file, openDb, openMemory) => {
    await legacy(root);
    const database = openDb(file);
    await database.initialize();
    inspect(file, (db) =>
      db.exec(`
      CREATE TRIGGER reject_import BEFORE INSERT ON memory_entries
      BEGIN SELECT RAISE(ABORT, 'memory import rejected'); END
    `),
    );
    await expect(database.initializeProducts()).rejects.toThrow();
    inspect(file, (db) => {
      for (const table of ['routines', 'routine_runs', 'panels', 'memory_scopes']) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
      }
      expect(
        db.prepare("SELECT value FROM metadata WHERE key='product-json-import-v1'").get(),
      ).toBeUndefined();
      db.exec('DROP TRIGGER reject_import');
    });
    await database.initializeProducts();
    expect(await openMemory(database).read('character', 'mage')).toEqual(memory.entries);
  }));

test('deletions remain authoritative after restart even when legacy files are stale or invalid', async () =>
  fixture(async (root, file, openDb, openMemory) => {
    await legacy(root);
    const routines = new RoutineStore(openDb(file));
    await routines.load();
    await routines.mutate('mage', { operation: 'remove', id: routine.id });
    const panels = new PanelStore(openDb(file));
    await panels.load();
    await panels.mutate('mage', { operation: 'remove', id: panel.id });
    await openMemory(openDb(file)).update('character', 'mage', 'guide');
    await writeFile(path.join(root, 'routines.json'), 'invalid stale JSON');
    await writeFile(path.join(root, 'memory', memoryName), 'invalid stale JSON');
    const reopened = new RoutineStore(openDb(file));
    await reopened.load();
    expect(reopened.list()).toEqual([]);
    expect(reopened.history()).toEqual([run]);
    const reopenedPanels = new PanelStore(openDb(file));
    await reopenedPanels.load();
    expect(reopenedPanels.panels).toEqual([]);
    expect(await openMemory(openDb(file)).read('character', 'mage')).toEqual([]);
  }));

test('independent stores preserve concurrent edits and a routine can only be claimed once', async () =>
  fixture(async (_root, file, openDb, openMemory) => {
    const first = new RoutineStore(openDb(file)),
      second = new RoutineStore(openDb(file));
    await Promise.all([first.load(), second.load()]);
    await Promise.all([
      first.mutate('mage', { operation: 'save', routine }, undefined, 0),
      second.mutate('warrior', { operation: 'save', routine }, undefined, 0),
    ]);
    const claims = await Promise.all([first.claim('mage', 1000000), second.claim('mage', 1000000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(second.list()).toHaveLength(2);
    const p1 = new PanelStore(openDb(file)),
      p2 = new PanelStore(openDb(file));
    await Promise.all([
      p1.mutate('mage', { operation: 'save', panel }),
      p2.mutate('warrior', { operation: 'save', panel }),
    ]);
    await p1.load();
    expect(p1.panels).toHaveLength(2);
    const m1 = openMemory(openDb(file)),
      m2 = openMemory(openDb(file));
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
  fixture(async (root, file, openDb, openMemory) => {
    const sources = await legacy(root);
    const source = `
      import { Effect, Layer } from 'effect';
      import * as Sql from '@wisp/db/sql-database';
      import * as Memory from '@wisp/server/memory-repository';
      import { ApplicationDatabase } from '@wisp/server/db/application-database';
      const [, file, key] = process.argv;
      const database = new ApplicationDatabase(file);
      try {
        await database.initializeProducts();
        const edit = Effect.flatMap(Memory.MemoryRepository, (memory) =>
          memory.update({ slot: 'character', owner: 'mage' }, { operation: 'save', key, text: 'Concurrent entry' }),
        );
        await Effect.runPromise(edit.pipe(
          Effect.provide(Memory.layer.pipe(Layer.provide(Sql.layer(file)))),
        ));
      } finally {
        await database.close();
      }
    `;
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
      (await openMemory(openDb(file)).read('character', 'mage')).map((entry) => entry.key).sort(),
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

test('memory rolls back a deletion if reordering the remaining entries fails', async () =>
  fixture(async (_root, file, openDb, openMemory) => {
    const repository = openMemory(openDb(file));
    await repository.update('character', 'mage', 'first', 'First note');
    const before = await repository.update('character', 'mage', 'second', 'Second note');
    inspect(file, (db) =>
      db.exec(`
        CREATE TRIGGER reject_reorder BEFORE UPDATE OF sort_index ON memory_entries
        BEGIN SELECT RAISE(ABORT, 'reorder rejected'); END
      `),
    );
    await expect(repository.update('character', 'mage', 'first')).rejects.toMatchObject({
      _tag: 'MemoryStorageError',
      operation: 'write',
    });
    expect(await repository.read('character', 'mage')).toEqual(before);
    inspect(file, (db) => db.exec('DROP TRIGGER reject_reorder'));
    expect(await repository.update('character', 'mage', 'first')).toEqual(before.slice(1));
  }));

test('a failed SQL mutation rolls back records and the next valid mutation still works', async () =>
  fixture(async (_root, file, openDb) => {
    const routines = new RoutineStore(openDb(file));
    await routines.mutate('mage', { operation: 'save', routine }, undefined, 0);
    inspect(file, (db) =>
      db.exec(
        "CREATE TRIGGER reject_run BEFORE INSERT ON routine_runs BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END",
      ),
    );
    await expect(routines.claim('mage', 1000000)).rejects.toMatchObject({
      cause: { message: 'disk write rejected' },
    });
    inspect(file, (db) => {
      expect(db.prepare('SELECT count(*) AS n FROM routine_runs').get()!.n).toBe(0);
      expect(db.prepare('SELECT next_at FROM routines').get()!.next_at).toBe(60000);
      db.exec('DROP TRIGGER reject_run');
    });
    expect(await routines.claim('mage', 1000000)).not.toBeNull();
  }));
