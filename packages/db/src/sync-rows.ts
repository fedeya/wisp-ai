import { isDeepStrictEqual } from 'node:util';
import { Effect, Schema } from 'effect';

/** Two rows in one snapshot share an identity, so the table cannot hold both. */
export class DuplicateRecord extends Schema.TaggedError<DuplicateRecord>()('DuplicateRecord', {
  message: Schema.String,
}) {}

/** Writes only the rows that changed between two snapshots of a table, keyed by identity. */
export const syncRows = Effect.fnUntraced(function* <T, E, R>(
  before: T[],
  after: T[],
  key: (row: T) => string,
  save: (row: T) => Effect.Effect<unknown, E, R>,
  remove: (row: T) => Effect.Effect<unknown, E, R>,
) {
  const old = new Map(before.map((row) => [key(row), row]));
  const next = new Map(after.map((row) => [key(row), row]));
  if (next.size !== after.length) {
    return yield* new DuplicateRecord({ message: 'Duplicate persisted record identity' });
  }
  for (const row of before) {
    if (!next.has(key(row))) {
      yield* remove(row);
    }
  }
  for (const row of after) {
    if (!isDeepStrictEqual(old.get(key(row)), row)) {
      yield* save(row);
    }
  }
});
