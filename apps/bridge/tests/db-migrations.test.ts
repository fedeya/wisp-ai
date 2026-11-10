import { test, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir, cp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { migrateDatabase, migrationsFolder } from '../src/db/migrate.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { ChatStore } from '../src/chat-store.ts';

test('the official Drizzle migrator creates the complete schema and shares its journal with Wisp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-drizzle-migrations-'));
  const file = path.join(root, 'wisp.sqlite');
  const database = new DatabaseSync(file);
  try {
    const names = (await readdir(migrationsFolder)).sort();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/_initial$/);
    migrateDatabase(database);
    const tables = database
      .prepare('PRAGMA table_list')
      .all()
      .filter((table) => !String(table.name).startsWith('sqlite_'));
    expect(tables.map((table) => table.name).sort()).toEqual([
      '__drizzle_migrations',
      'chat_instance_state',
      'chats',
      'memory_entries',
      'memory_scopes',
      'messages',
      'metadata',
      'panels',
      'routine_runs',
      'routines',
    ]);
    expect(
      tables
        .filter((table) => table.name !== '__drizzle_migrations')
        .every((table) => table.strict === 1),
    ).toBe(true);
    const chat = {
      ...newChat('existing', 'game'),
      messages: [{ role: 'user' as const, text: 'Keep this 🧙' }],
    };
    const store = new ChatStore(file, () => {});
    try {
      await store.load();
      await store.flush([chat]);
    } finally {
      await store.close();
    }
    const before = database.prepare('SELECT * FROM chats').all();
    migrate(drizzle({ client: database }), { migrationsFolder });
    expect(database.prepare('SELECT * FROM chats').all()).toEqual(before);
    expect(database.prepare('SELECT role, text FROM messages').get()).toEqual(chat.messages[0]);
    expect(database.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(1);
    const folder = path.join(root, 'migrations');
    await cp(migrationsFolder, folder, { recursive: true });
    const pending = path.join(folder, '20980101000000_next');
    await mkdir(pending);
    await writeFile(
      path.join(pending, 'migration.sql'),
      'CREATE TABLE next_feature(id INTEGER PRIMARY KEY) STRICT;',
    );
    migrateDatabase(database, folder);
    migrate(drizzle({ client: database }), { migrationsFolder: folder });
    expect(database.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(2);
    const failing = path.join(folder, '20990101000000_failure');
    await mkdir(failing);
    await writeFile(
      path.join(failing, 'migration.sql'),
      'CREATE TABLE should_rollback(id INTEGER);\n--> statement-breakpoint\nINVALID SQL;',
    );
    expect(() => migrateDatabase(database, folder)).toThrow();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(),
    ).toBeUndefined();
    expect(database.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(2);
    expect(database.prepare('SELECT * FROM chats').all()).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a failed initial migration rolls back every table and can retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-initial-rollback-'));
  const database = new DatabaseSync(path.join(root, 'wisp.sqlite'));
  try {
    const folder = path.join(root, 'migrations');
    await cp(migrationsFolder, folder, { recursive: true });
    const [name] = await readdir(folder);
    const file = path.join(folder, name, 'migration.sql');
    await writeFile(
      file,
      (await readFile(file, 'utf8')) + '\n--> statement-breakpoint\nINVALID SQL;',
    );
    expect(() => migrateDatabase(database, folder)).toThrow();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
      { name: '__drizzle_migrations' },
    ]);
    expect(database.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(0);
    migrateDatabase(database);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unrecognized pre-release tables are preserved instead of being adopted or replaced', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      "CREATE TABLE chats(id TEXT PRIMARY KEY, metadata TEXT); INSERT INTO chats VALUES('keep', 'original');",
    );
    expect(() => migrateDatabase(database)).toThrow();
    expect(database.prepare('SELECT * FROM chats').all()).toEqual([
      { id: 'keep', metadata: 'original' },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
      { name: 'chats' },
      { name: '__drizzle_migrations' },
    ]);
  } finally {
    database.close();
  }
});

test('startup succeeds when another connection commits after Drizzle reads the empty journal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-migration-race-'));
  const file = path.join(root, 'wisp.sqlite');
  const first = new DatabaseSync(file);
  const second = new DatabaseSync(file);
  try {
    const folder = path.join(root, 'failed-migrations', '20990101000000_failure');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'migration.sql'), 'INVALID SQL;');
    // Let Drizzle create its own empty journal before either startup applies SQL.
    expect(() =>
      migrate(drizzle({ client: first }), { migrationsFolder: path.dirname(folder) }),
    ).toThrow();
    const prepare = first.prepare.bind(first);
    let competingStartup = false;
    first.prepare = (query) => {
      if (query.trim().toUpperCase() === 'BEGIN' && !competingStartup) {
        competingStartup = true;
        migrateDatabase(second);
      }
      return prepare(query);
    };
    migrateDatabase(first);
    expect(competingStartup).toBe(true);
    expect(first.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n).toBe(1);
    expect(first.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('three processes can migrate and import the same database simultaneously', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-drizzle-processes-'));
  try {
    const legacy = [
      { ...newChat('legacy', 'game'), messages: [{ role: 'user', text: 'Import once' }] },
    ];
    await writeFile(path.join(root, 'chats.json'), JSON.stringify(legacy));
    const source = `
      import { ChatStore } from '@wisp/bridge/chat-store';
      const store = new ChatStore(process.argv[1], (error) => { throw error; });
      try { console.log(JSON.stringify((await store.load()).map(c => c.id))); }
      finally { await store.close(); }
    `;
    const settled = await Promise.allSettled(
      [1, 2, 3].map(() =>
        promisify(execFile)(
          process.execPath,
          ['--input-type=module', '-e', source, path.join(root, 'wisp.sqlite')],
          { cwd: fileURLToPath(new URL('.', import.meta.url)), windowsHide: true },
        ),
      ),
    );
    const results = settled.map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      return result.value;
    });
    expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual([
      ['legacy'],
      ['legacy'],
      ['legacy'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
