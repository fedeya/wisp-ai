import { Effect, Schema } from 'effect';
import type { SqlDatabase } from '@wisp/db/sql-database';
import { readMemory, saveMemory, type MemorySlot, type MemoryEntry } from './memory-record.ts';
export type { MemorySlot, MemoryEntry } from './memory-record.ts';

/** A memory change the store refuses, with the reason shown to the player. */
export class MemoryRejected extends Schema.TaggedError<MemoryRejected>()('MemoryRejected', {
  message: Schema.String,
}) {}

const size = (list: MemoryEntry[]) => list.reduce((sum, entry) => sum + entry.text.length, 0);

/** The player's preferences and each character's memory. */
export function makeMemoryStore({ db }: SqlDatabase['Service']) {
  const read = Effect.fn('MemoryStore.read')(function* (slot: MemorySlot, owner: string) {
    return yield* readMemory(db, slot, owner);
  });
  const update = Effect.fn('MemoryStore.update')(function* (
    slot: MemorySlot,
    owner: string,
    key: string,
    text?: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
      return yield* new MemoryRejected({ message: 'Memory keys must be short identifiers' });
    }
    if (text !== undefined && (!text.trim() || text.length > 1000)) {
      return yield* new MemoryRejected({ message: 'Memory entries require 1–1000 characters' });
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
        if (grows && (entries.length > 40 || size(entries) > 6000)) {
          return yield* new MemoryRejected({
            message: 'Memory is full; remove or shorten outdated entries first',
          });
        }
        yield* saveMemory(tx, slot, owner, entries);
        return entries;
      }),
    );
  });
  return { read, update };
}

export type MemoryStore = ReturnType<typeof makeMemoryStore>;
