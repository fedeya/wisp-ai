import { EffectDrizzleQueryError, EffectTransactionRollbackError } from 'drizzle-orm/effect-core';
import { Cause, Effect, Predicate, Schema } from 'effect';
import { isSqlError, type SqlError } from 'effect/sql/SqlError';

/** A query or transaction failed in SQLite. Repositories report it as one of their reasons. */
export class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()('DatabaseFailure', {
  cause: Schema.Defect(),
}) {
  override get message() {
    return 'The application database failed: ' + describe(this.cause);
  }
}

/** A stored row does not match its schema, so it is reported instead of being returned. */
export class CorruptRecord extends Schema.TaggedError<CorruptRecord>()('CorruptRecord', {
  table: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `A saved ${this.table} record is damaged: ` + describe(this.cause);
  }
}

export type SqlFailure = EffectDrizzleQueryError | EffectTransactionRollbackError | SqlError;

const isSqlFailure = (error: unknown): error is SqlFailure =>
  isSqlError(error) ||
  error instanceof EffectDrizzleQueryError ||
  error instanceof EffectTransactionRollbackError;

/** Keeps SQLite's own errors inside a repository: they leave it as a DatabaseFailure. */
export const sqlFailures = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    self,
    (error: E): error is Extract<E, SqlFailure> => isSqlFailure(error),
    (cause) => Effect.fail(new DatabaseFailure({ cause })),
  );

/** The runtime check a record schema offers, such as a zod schema's `safeParse`. */
export interface RecordSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * Checks a row rebuilt from its columns against the schema that owns its
 * shape. Fields the schema does not know are kept, so data written by a newer
 * version survives a round trip through this one.
 */
export const decodeRecord = <T extends object>(
  table: string,
  schema: RecordSchema<T>,
  build: () => Record<string, unknown>,
): Effect.Effect<T, CorruptRecord> =>
  Effect.try({ try: build, catch: (cause) => new CorruptRecord({ table, cause }) }).pipe(
    Effect.flatMap((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? Effect.succeed({ ...value, ...parsed.data })
        : Effect.fail(new CorruptRecord({ table, cause: parsed.error }));
    }),
  );

/** The innermost message in a chain of causes: what SQLite or the parser actually reported. */
const describe = (cause: unknown) => {
  let message = String(cause);
  for (let current = cause, depth = 0; depth < 10; depth++) {
    // Drizzle keeps the failed query's Effect Cause; its squashed error carries on.
    if (Cause.isCause(current)) current = Cause.squash(current);
    if (!Predicate.hasProperty(current, 'message')) break;
    if (typeof current.message === 'string' && current.message) message = current.message;
    if (!Predicate.hasProperty(current, 'cause') || current.cause === current) break;
    current = current.cause;
  }
  return message;
};
