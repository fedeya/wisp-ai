import { expect, layer } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { Effect, Exit, FileSystem } from 'effect';
import { migrateDatabase, migrationsFolder } from '../src/migrate.ts';
import { metadata } from '../src/schema.ts';
import * as Sql from '../src/sql-database.ts';

/** A database path in a temporary directory that the test's scope removes. */
const temporaryFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-sql-db-' });
  return path.join(root, 'wisp.sqlite');
});

const migrationCount = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readDirectory(migrationsFolder)).length;
});

/** Opens the database at `file` for `work`, then closes it. */
const run = <A, E>(file: string, work: Effect.Effect<A, E, Sql.SqlDatabase>) =>
  work.pipe(Effect.provide(Sql.layer(file)));

const journal = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id').all();
  } finally {
    db.close();
  }
};

// These tests use a real SQLite file, whose migration retry waits on the real
// clock, so the block runs without the TestClock.
layer(NodeFileSystem.layer, { excludeTestServices: true })('SqlDatabase', (it) => {
  it.effect(
    'a database migrated by the synchronous migrator opens without reapplying migrations',
    () =>
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const existing = new DatabaseSync(file);
        migrateDatabase(existing);
        existing.prepare("INSERT INTO metadata (key, value) VALUES ('kept', 'yes')").run();
        existing.close();
        const before = journal(file);

        const kept = yield* run(
          file,
          Effect.gen(function* () {
            const { db } = yield* Sql.SqlDatabase;
            return yield* db.select().from(metadata).where(eq(metadata.key, 'kept'));
          }),
        );

        expect(kept).toEqual([{ key: 'kept', value: 'yes' }]);
        expect(journal(file)).toEqual(before);
        expect(before).toHaveLength(yield* migrationCount);
      }),
  );

  it.effect('a new database gets the same journal as the synchronous migrator', () =>
    Effect.gen(function* () {
      const effectFile = yield* temporaryFile;
      const syncFile = yield* temporaryFile;
      yield* run(effectFile, Effect.void);
      const sync = new DatabaseSync(syncFile);
      migrateDatabase(sync);
      sync.close();

      expect(journal(effectFile)).toEqual(journal(syncFile));
      const pragmas = yield* run(
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
    }),
  );

  it.effect('simultaneous startups both open the database', () =>
    Effect.gen(function* () {
      const file = yield* temporaryFile;
      const open = run(file, Effect.void);
      const opened = yield* Effect.all([open, open, open], { concurrency: 'unbounded' });
      expect(opened).toHaveLength(3);
      expect(journal(file)).toHaveLength(yield* migrationCount);
    }),
  );

  it.effect('a failed transaction rolls back and the layer closes the connection', () =>
    Effect.gen(function* () {
      const file = yield* temporaryFile;
      const exit = yield* run(
        file,
        Effect.gen(function* () {
          const { db } = yield* Sql.SqlDatabase;
          return yield* db.transaction((tx) =>
            tx
              .insert(metadata)
              .values({ key: 'rolled-back', value: 'x' })
              .pipe(Effect.andThen(Effect.fail('stop'))),
          );
        }),
      ).pipe(Effect.exit);
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
    }),
  );

  it.effect('a missing directory is created privately before SQLite opens the file', () =>
    Effect.gen(function* () {
      const file = path.join(path.dirname(yield* temporaryFile), 'nested', 'wisp.sqlite');
      expect(yield* run(file, Effect.void)).toBeUndefined();
    }),
  );
});
