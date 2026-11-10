import { test, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir, cp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { migrateChats, migrationsFolder } from '@wisp/bridge/db/migrate';
import { newChat } from '@wisp/bridge/chat-lifecycle';

test('Drizzle adopts existing v1 rows, is repeatable, rejects drift and rolls back failed upgrades', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-drizzle-migrations-'));
  const database = new DatabaseSync(path.join(root, 'v1.sqlite'));
  try {
    const names = (await readdir(migrationsFolder)).sort();
    const initial = path.join(names[0], 'migration.sql');
    database.exec(await readFile(path.join(migrationsFolder, initial), 'utf8'));
    const chat = {
      ...newChat('existing', 'game'),
      messages: [{ role: 'user', text: 'Keep this 🧙' }],
    };
    const { messages, ...metadata } = chat;
    database
      .prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?)')
      .run(chat.id, 0, null, 0, 7, JSON.stringify(metadata));
    database
      .prepare('INSERT INTO messages VALUES (?, ?, ?)')
      .run(chat.id, 0, JSON.stringify(messages[0]));
    database.exec("INSERT INTO metadata VALUES ('initialized', '1'); PRAGMA user_version=1");
    const before = database.prepare('SELECT * FROM chats').all();
    migrateChats(database);
    migrateChats(database);
    expect(database.prepare('SELECT * FROM chats').all()).toEqual(before);
    expect(
      JSON.parse(String(database.prepare('SELECT content FROM messages').get()!.content)),
    ).toEqual(messages[0]);
    expect(database.prepare('SELECT count(*) AS n FROM wisp_migrations').get()!.n).toBe(
      names.length,
    );
    const folder = path.join(root, 'migrations');
    await cp(migrationsFolder, folder, { recursive: true });
    const migration = path.join(folder, initial);
    await writeFile(migration, (await readFile(migration, 'utf8')) + '\n-- changed');
    expect(() => migrateChats(database, folder)).toThrow('migrations differ');
    await cp(migrationsFolder, folder, { recursive: true });
    const failing = path.join(folder, '20990101000000_failure');
    await mkdir(failing);
    await writeFile(
      path.join(failing, 'migration.sql'),
      'CREATE TABLE should_rollback(id INTEGER);\n--> statement-breakpoint\nINVALID SQL;',
    );
    expect(() => migrateChats(database, folder)).toThrow();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(),
    ).toBeUndefined();
    expect(database.prepare('SELECT count(*) AS n FROM wisp_migrations').get()!.n).toBe(
      names.length,
    );
    expect(database.prepare('SELECT * FROM chats').all()).toEqual(before);
  } finally {
    database.close();
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
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        promisify(execFile)(
          process.execPath,
          ['--input-type=module', '-e', source, path.join(root, 'chats.sqlite')],
          {
            cwd: fileURLToPath(new URL('.', import.meta.url)),
            windowsHide: true,
          },
        ),
      ),
    );
    expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual([
      ['legacy'],
      ['legacy'],
      ['legacy'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
