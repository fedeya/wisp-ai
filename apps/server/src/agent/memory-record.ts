import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { memoryEntry } from '@wisp/agent/contract/agent-rpc';
import type { ApplicationOrm } from '@wisp/db/database';
import { memoryEntries, memoryScopes } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';

export type MemorySlot = 'preferences' | 'character';
export type MemoryEntry = z.infer<typeof memoryEntry>;

export function readMemory(db: ApplicationOrm, slot: MemorySlot, owner: string): MemoryEntry[] {
  return db
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner)))
    .orderBy(memoryEntries.sortIndex)
    .all()
    .map(({ slot: _slot, owner: _owner, sortIndex: _sortIndex, extras, ...row }) => ({
      ...JSON.parse(extras),
      ...row,
    }));
}

export function saveMemory(
  db: ApplicationOrm,
  slot: MemorySlot,
  owner: string,
  entries: MemoryEntry[],
  extras = '{}',
) {
  db.insert(memoryScopes).values({ slot, owner, extras }).onConflictDoNothing().run();
  const next = entries.map(({ key, text, updatedAt, ...extra }, sortIndex) => ({
    slot,
    owner,
    key,
    text,
    updatedAt,
    sortIndex,
    extras: JSON.stringify(extra),
  }));
  syncRows(
    db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner)))
      .all(),
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
        .where(
          and(
            eq(memoryEntries.slot, slot),
            eq(memoryEntries.owner, owner),
            eq(memoryEntries.key, r.key),
          ),
        )
        .run(),
  );
}
