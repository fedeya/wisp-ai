import { Context, Effect, Layer, Schema } from 'effect';
import { CorruptRecord, DatabaseFailure, sqlFailures, type SqlFailure } from '@wisp/db/repository';
import { SqlDatabase } from '@wisp/db/sql-database';
import { DuplicateRecord } from '@wisp/db/sync-rows';
import { readMemory, saveMemory, type MemorySlot, type MemoryEntry } from './memory-record.ts';
export type { MemorySlot, MemoryEntry } from './memory-record.ts';

/** A memory change the store refuses, with the reason shown to the player. */
export class MemoryRejected extends Schema.TaggedError<MemoryRejected>()('MemoryRejected', {
  message: Schema.String,
}) {}

/** A memory operation failed; `reason` says whether the player or the database caused it. */
export class MemoryStoreError extends Schema.TaggedError<MemoryStoreError>()('MemoryStoreError', {
  reason: Schema.Union([MemoryRejected, DatabaseFailure, CorruptRecord, DuplicateRecord]),
}) {
  override get message() {
    return this.reason.message;
  }
}

/** The player's preferences and each character's memory. */
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    readonly read: (
      slot: MemorySlot,
      owner: string,
    ) => Effect.Effect<MemoryEntry[], MemoryStoreError>;
    /** Saves `text` under `key`, or forgets the key when `text` is left out. */
    readonly update: (
      slot: MemorySlot,
      owner: string,
      key: string,
      text?: string,
    ) => Effect.Effect<MemoryEntry[], MemoryStoreError>;
  }
>()('@wisp/server/MemoryStore') {}

const MAX_ENTRIES = 40;
const MAX_CHARACTERS = 6000;
const size = (list: MemoryEntry[]) => list.reduce((sum, entry) => sum + entry.text.length, 0);

const memoryErrors = <A, R>(self: Effect.Effect<A, MemoryStoreError['reason'] | SqlFailure, R>) =>
  sqlFailures(self).pipe(Effect.mapError((reason) => new MemoryStoreError({ reason })));

const reject = (message: string) => Effect.fail(new MemoryRejected({ message }));

export const layer = Layer.effect(
  MemoryStore,
  Effect.gen(function* () {
    const { db } = yield* SqlDatabase;
    return MemoryStore.of({
      read: Effect.fn('MemoryStore.read')(function* (slot: MemorySlot, owner: string) {
        return yield* readMemory(db, slot, owner);
      }, memoryErrors),

      update: Effect.fn('MemoryStore.update')(function* (
        slot: MemorySlot,
        owner: string,
        key: string,
        text?: string,
      ) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
          return yield* reject('Memory keys must be short identifiers');
        }
        if (text !== undefined && (!text.trim() || text.length > 1000)) {
          return yield* reject('Memory entries require 1–1000 characters');
        }
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const before = yield* readMemory(tx, slot, owner);
            const entries = before.filter((entry) => entry.key !== key);
            if (text !== undefined) {
              entries.push({ key, text: text.trim(), updatedAt: new Date().toISOString() });
            }
            // Merged character memory can start over quota, so changes that do not
            // grow it stay allowed until it has been trimmed.
            const grows = entries.length > before.length || size(entries) > size(before);
            if (grows && (entries.length > MAX_ENTRIES || size(entries) > MAX_CHARACTERS)) {
              return yield* reject('Memory is full; remove or shorten outdated entries first');
            }
            yield* saveMemory(tx, slot, owner, entries);
            return entries;
          }),
        );
      }, memoryErrors),
    });
  }),
);
