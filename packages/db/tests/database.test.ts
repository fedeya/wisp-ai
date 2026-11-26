import { test, expect, onTestFinished } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Database } from '../src/database.ts';
import { migrationsFolder } from '../src/migrate.ts';
import { metadata } from '../src/schema.ts';

async function temporaryDatabase() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-db-'));
  const database = new Database(path.join(root, 'nested', 'wisp.sqlite'));
  onTestFinished(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  return database;
}

test('opening the database applies every migration in WAL mode', async () => {
  const database = await temporaryDatabase();
  await database.initialize();
  const { connection } = database;
  expect(connection.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  expect(connection.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(connection.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
    n: (await readdir(migrationsFolder)).length,
  });
});

test('transactions commit their writes and reject asynchronous work', async () => {
  const database = await temporaryDatabase();
  await database.transaction((db) => db.insert(metadata).values({ key: 'k', value: 'v' }).run());
  expect(database.orm.select().from(metadata).where(eq(metadata.key, 'k')).get()).toEqual({
    key: 'k',
    value: 'v',
  });
  await expect(database.transaction(async () => {})).rejects.toThrow('must be synchronous');
});

test('a closed database cannot be reopened or used', async () => {
  const database = await temporaryDatabase();
  await database.initialize();
  await database.close();
  expect(() => database.orm).toThrow('not open');
  await expect(database.initialize()).rejects.toThrow('closed');
});
