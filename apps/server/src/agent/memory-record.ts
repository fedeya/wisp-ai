import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import type { z } from 'zod';
import { memoryEntry } from '@wisp/agent/contract/agent-rpc';
import { decodeRecord } from '@wisp/db/repository';
import type { SqlExecutor } from '@wisp/db/sql-database';
import { memoryEntries, memoryScopes } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';

export type MemorySlot = 'preferences' | 'character';
export type MemoryEntry = z.infer<typeof memoryEntry>;

const scope = (slot: MemorySlot, owner: string) =>
  and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner));

export const readMemory = (db: SqlExecutor, slot: MemorySlot, owner: string) =>
  db
    .select()
    .from(memoryEntries)
    .where(scope(slot, owner))
    .orderBy(memoryEntries.sortIndex)
    .all()
    .pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          ({ slot: _slot, owner: _owner, sortIndex: _sortIndex, extras, ...row }) =>
            decodeRecord<MemoryEntry>('memory', memoryEntry, () => ({
              ...JSON.parse(extras),
              ...row,
            })),
        ),
      ),
    );

export const saveMemory = Effect.fnUntraced(function* (
  db: SqlExecutor,
  slot: MemorySlot,
  owner: string,
  entries: MemoryEntry[],
  extras = '{}',
) {
  yield* db.insert(memoryScopes).values({ slot, owner, extras }).onConflictDoNothing().run();
  const next = entries.map(({ key, text, updatedAt, ...extra }, sortIndex) => ({
    slot,
    owner,
    key,
    text,
    updatedAt,
    sortIndex,
    extras: JSON.stringify(extra),
  }));
  yield* syncRows(
    yield* db.select().from(memoryEntries).where(scope(slot, owner)).all(),
    next,
    (r) => r.key,
    (r) =>
      db
        .insert(memoryEntries)
        .values(r)
        .onConflictDoUpdate({
          target: [memoryEntries.slot, memoryEntries.owner, memoryEntries.key],
          set: r,
        })
        .run(),
    (r) =>
      db
        .delete(memoryEntries)
        .where(and(scope(slot, owner), eq(memoryEntries.key, r.key)))
        .run(),
  );
});
