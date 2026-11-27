import { and, eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { MemoryEntry, MemoryKey, memoryTextLimit } from '@wisp/agent/contract/memory';
import type { MemoryEdit, MemorySlot } from '@wisp/agent/contract/memory';
import { memoryEntries, memoryScopes } from '@wisp/db/schema';
import { SqlDatabase } from '@wisp/db/sql-database';
import type { SqlOrm } from '@wisp/db/sql-database';
import { syncRows } from '@wisp/db/sync-rows';

const extensions = Schema.Record(Schema.String, Schema.Unknown);
export const StoredMemoryEntry = Schema.StructWithRest(MemoryEntry, [extensions]);

type MemoryScope = { readonly slot: MemorySlot; readonly owner: string };
type StoredMemoryEntry = typeof StoredMemoryEntry.Type;
type MemoryRow = typeof memoryEntries.$inferSelect;

class MemoryStorageError extends Schema.TaggedError<MemoryStorageError>()('MemoryStorageError', {
  operation: Schema.Literals(['read', 'decode', 'write']),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Could not ${this.operation} saved memory`;
  }
}

class InvalidMemoryEdit extends Schema.TaggedError<InvalidMemoryEdit>()('InvalidMemoryEdit', {
  message: Schema.String,
}) {}

class MemoryQuotaExceeded extends Schema.TaggedError<MemoryQuotaExceeded>()(
  'MemoryQuotaExceeded',
  {},
) {
  override get message() {
    return 'Memory is full; remove or shorten outdated entries first';
  }
}

export class MemoryRepository extends Context.Service<
  MemoryRepository,
  {
    readonly read: (scope: MemoryScope) => Effect.Effect<StoredMemoryEntry[], MemoryStorageError>;
    readonly update: (
      scope: MemoryScope,
      edit: MemoryEdit,
    ) => Effect.Effect<
      StoredMemoryEntry[],
      MemoryStorageError | InvalidMemoryEdit | MemoryQuotaExceeded
    >;
  }
>()('@wisp/server/memory/MemoryRepository') {}

const inScope = ({ slot, owner }: MemoryScope) =>
  and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner));

const encodeEntries = (scope: MemoryScope, entries: readonly StoredMemoryEntry[]): MemoryRow[] =>
  entries.map(({ key, text, updatedAt, ...extra }, sortIndex) => ({
    ...scope,
    key,
    text,
    updatedAt,
    sortIndex,
    extras: JSON.stringify(extra),
  }));

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...MemoryEntry.fields, extras: Schema.fromJsonString(extensions) })),
);
const decodeEntries = (rows: MemoryRow[]) =>
  decodeRows(rows).pipe(
    Effect.map((entries) => entries.map(({ extras, ...entry }) => ({ ...extras, ...entry }))),
    Effect.mapError((cause) => new MemoryStorageError({ operation: 'decode', cause })),
  );
const isMemoryKey = Schema.is(MemoryKey);

/** Runs inside the legacy importer's transaction spanning all product data. */
export const importMemory = Effect.fn('MemoryRepository.import')(function* (
  db: SqlOrm,
  scope: MemoryScope,
  entries: readonly StoredMemoryEntry[],
  extras: string,
) {
  yield* db.insert(memoryScopes).values({ ...scope, extras });
  for (const row of encodeEntries(scope, entries)) yield* db.insert(memoryEntries).values(row);
});

/** Runs inside character adoption's transaction; existing GUID entries win. */
export const adoptMemoryOwner = Effect.fn('MemoryRepository.adoptOwner')(function* (
  db: SqlOrm,
  from: string,
  to: string,
) {
  const scope = yield* db
    .select()
    .from(memoryScopes)
    .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)))
    .get();
  if (!scope) return;
  yield* db
    .insert(memoryScopes)
    .values({ ...scope, owner: to })
    .onConflictDoNothing();
  const entries = yield* db
    .select()
    .from(memoryEntries)
    .where(inScope({ slot: 'character', owner: from }));
  for (const entry of entries) {
    yield* db
      .insert(memoryEntries)
      .values({ ...entry, owner: to })
      .onConflictDoNothing();
  }
  // The foreign key cascades removal to the old scope's entries.
  yield* db
    .delete(memoryScopes)
    .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)));
});

const textSize = (entries: readonly StoredMemoryEntry[]) =>
  entries.reduce((size, entry) => size + entry.text.length, 0);

export const layer = Layer.effect(
  MemoryRepository,
  Effect.gen(function* () {
    const { db } = yield* SqlDatabase;
    const select = (scope: MemoryScope) =>
      db
        .select()
        .from(memoryEntries)
        .where(inScope(scope))
        .orderBy(memoryEntries.sortIndex)
        .pipe(Effect.mapError((cause) => new MemoryStorageError({ operation: 'read', cause })));

    const read = Effect.fn('MemoryRepository.read')((scope: MemoryScope) =>
      select(scope).pipe(Effect.flatMap(decodeEntries)),
    );

    const update = Effect.fn('MemoryRepository.update')(function* (
      scope: MemoryScope,
      edit: MemoryEdit,
    ) {
      const { key } = edit;
      if (!isMemoryKey(key)) {
        return yield* new InvalidMemoryEdit({ message: 'Memory keys must be short identifiers' });
      }
      if (edit.operation === 'save' && (!edit.text.trim() || edit.text.length > memoryTextLimit)) {
        return yield* new InvalidMemoryEdit({
          message: 'Memory entries require 1–1000 characters',
        });
      }

      // The writable SQLite client uses BEGIN IMMEDIATE, so concurrent writers
      // cannot change this scope between the quota check and the write.
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* select(scope);
            const before = yield* decodeEntries(rows);
            const entries = before.filter((entry) => entry.key !== key);
            if (edit.operation === 'save') {
              entries.push({
                key,
                text: edit.text.trim(),
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              });
            }
            const size = textSize(entries);
            // Character adoption may leave a scope over quota; it can still be trimmed.
            const grows = entries.length > before.length || size > textSize(before);
            if (grows && (entries.length > 40 || size > 6000)) {
              return yield* new MemoryQuotaExceeded();
            }

            const changed: MemoryRow[] = [];
            const removed: MemoryRow[] = [];
            syncRows(
              rows,
              encodeEntries(scope, entries),
              (row) => row.key,
              (row) => changed.push(row),
              (row) => removed.push(row),
            );
            yield* db
              .insert(memoryScopes)
              .values({ ...scope, extras: '{}' })
              .onConflictDoNothing();
            for (const row of removed) {
              yield* db
                .delete(memoryEntries)
                .where(and(inScope(scope), eq(memoryEntries.key, row.key)));
            }
            for (const row of changed) {
              yield* db
                .insert(memoryEntries)
                .values(row)
                .onConflictDoUpdate({
                  target: [memoryEntries.slot, memoryEntries.owner, memoryEntries.key],
                  set: row,
                });
            }
            return entries;
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) => new MemoryStorageError({ operation: 'write', cause }),
            EffectDrizzleQueryError: (cause) =>
              new MemoryStorageError({ operation: 'write', cause }),
          }),
        );
    });

    return MemoryRepository.of({ read, update });
  }),
);
