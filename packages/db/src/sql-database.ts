import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqliteDrizzle from 'drizzle-orm/effect-sqlite-node';
import { migrate } from 'drizzle-orm/effect-sqlite-node/migrator';
import type { SQLiteEffectDatabase } from 'drizzle-orm/sqlite-core/effect';
import { Context, Effect, Layer, Schedule, Schema } from 'effect';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { migrationsFolder } from './migrate.ts';
import { preparePrivateDatabase } from './private-file.ts';

/** Opening, migrating or querying the application database failed. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  operation: Schema.Literals(['open', 'migrate']),
  cause: Schema.Defect(),
}) {}

export type SqlOrm = SqliteDrizzle.EffectSQLiteNodeDatabase & {
  $client: SqliteClient.SqliteClient;
};

/** The database or an open transaction on it: queries read the same either way. */
export type SqlExecutor = SQLiteEffectDatabase<
  SqliteDrizzle.EffectSQLiteNodeQueryEffectHKT,
  SqliteDrizzle.EffectSQLiteNodeRunResult
>;

/** Wisp's SQLite file as an Effect Drizzle database: open, in WAL mode and migrated. */
export class SqlDatabase extends Context.Service<SqlDatabase, { readonly db: SqlOrm }>()(
  '@wisp/db/SqlDatabase',
) {}

// Drizzle reads its journal before BEGIN, so a concurrent startup can win the
// migration race: retry lock contention and a table created by the winner.
const isMigrationRace = (error: unknown): boolean => {
  const text = String(error instanceof Error && error.cause ? error.cause : error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|table .+ already exists/i.test(text);
};

export const make = Effect.fnUntraced(function* (file: string, folder = migrationsFolder) {
  yield* Effect.tryPromise({
    try: () => preparePrivateDatabase(file),
    catch: (cause) => new DatabaseError({ operation: 'open', cause }),
  });
  const client = yield* SqliteClient.make({ filename: file }).pipe(
    Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
    Effect.mapError((cause) => new DatabaseError({ operation: 'open', cause })),
  );
  yield* client`PRAGMA foreign_keys = ON`.pipe(
    Effect.andThen(client`PRAGMA synchronous = FULL`),
    Effect.mapError((cause) => new DatabaseError({ operation: 'open', cause })),
  );
  const db = yield* SqliteDrizzle.makeWithDefaults().pipe(
    Effect.provideService(SqliteClient.SqliteClient, client),
  );
  yield* migrate(db, { migrationsFolder: folder }).pipe(
    Effect.retry({ while: isMigrationRace, times: 2, schedule: Schedule.spaced('25 millis') }),
    Effect.mapError((cause) => new DatabaseError({ operation: 'migrate', cause })),
  );
  return SqlDatabase.of({ db });
});

export const layer = (file: string) => Layer.effect(SqlDatabase, make(file));
