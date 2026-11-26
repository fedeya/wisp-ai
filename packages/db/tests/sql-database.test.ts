import { test, expect, onTestFinished } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import { migrateDatabase, migrationsFolder } from '../src/migrate.ts';
import { metadata } from '../src/schema.ts';
import * as Sql from '../src/sql-database.ts';

async function temporaryFile() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-sql-db-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'wisp.sqlite');
}

const run = <A, E>(file: string, work: Effect.Effect<A, E, Sql.SqlDatabase>) =>
  Effect.runPromise(work.pipe(Effect.provide(Sql.layer(file))));

const journal = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id').all();
  } finally {
    db.close();
  }
};

test('a database migrated by the synchronous migrator opens without reapplying migrations', async () => {
  const file = await temporaryFile();
  const existing = new DatabaseSync(file);
  migrateDatabase(existing);
  existing.prepare("INSERT INTO metadata (key, value) VALUES ('kept', 'yes')").run();
  existing.close();
  const before = journal(file);

  const kept = await run(
    file,
    Effect.gen(function* () {
      const { db } = yield* Sql.SqlDatabase;
      return yield* db.select().from(metadata).where(eq(metadata.key, 'kept'));
    }),
  );

  expect(kept).toEqual([{ key: 'kept', value: 'yes' }]);
  expect(journal(file)).toEqual(before);
  expect(before).toHaveLength((await readdir(migrationsFolder)).length);
});

test('a new database gets the same journal as the synchronous migrator', async () => {
  const [effectFile, syncFile] = [await temporaryFile(), await temporaryFile()];
  await run(effectFile, Effect.void);
  const sync = new DatabaseSync(syncFile);
  migrateDatabase(sync);
  sync.close();

  expect(journal(effectFile)).toEqual(journal(syncFile));
  const pragmas = await run(
    effectFile,
    Effect.gen(function* () {
      const { db } = yield* Sql.SqlDatabase;
      return {
        journal: yield* db.$client`PRAGMA journal_mode`,
        foreignKeys: yield* db.$client`PRAGMA foreign_keys`,
      };
    }),
  );
  expect(pragmas).toEqual({
    journal: [{ journal_mode: 'wal' }],
    foreignKeys: [{ foreign_keys: 1 }],
  });
});

test('simultaneous startups both open the database', async () => {
  const file = await temporaryFile();
  const open = () => run(file, Effect.void);
  await expect(Promise.all([open(), open(), open()])).resolves.toHaveLength(3);
  expect(journal(file)).toHaveLength((await readdir(migrationsFolder)).length);
});

test('a failed transaction rolls back and the layer closes the connection', async () => {
  const file = await temporaryFile();
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { db } = yield* Sql.SqlDatabase;
      return yield* db.transaction((tx) =>
        tx
          .insert(metadata)
          .values({ key: 'rolled-back', value: 'x' })
          .pipe(Effect.andThen(Effect.fail('stop'))),
      );
    }).pipe(Effect.provide(Sql.layer(file))),
  );
  expect(Exit.isFailure(exit)).toBe(true);

  // A closed connection leaves no WAL lock behind: a plain connection can checkpoint.
  const after = new DatabaseSync(file);
  try {
    expect(
      after.prepare("SELECT count(*) AS n FROM metadata WHERE key = 'rolled-back'").get(),
    ).toEqual({ n: 0 });
    after.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    after.close();
  }
});

test('a missing directory is created privately before SQLite opens the file', async () => {
  const file = path.join(path.dirname(await temporaryFile()), 'nested', 'wisp.sqlite');
  await expect(run(file, Effect.void)).resolves.toBeUndefined();
});
