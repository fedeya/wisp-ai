import { and, eq } from 'drizzle-orm';
import { sameCharacter } from '@wisp/protocol/character-key';
import type { ApplicationOrm } from './application-database.ts';
import { chats, memoryEntries, memoryScopes, panels, routineRuns, routines } from './schema.ts';

function storedKeys(db: ApplicationOrm) {
  return new Set([
    ...db
      .selectDistinct({ key: chats.characterKey })
      .from(chats)
      .all()
      .map((row) => row.key),
    ...db
      .selectDistinct({ key: routines.characterKey })
      .from(routines)
      .all()
      .map((row) => row.key),
    ...db
      .selectDistinct({ key: routineRuns.characterKey })
      .from(routineRuns)
      .all()
      .map((row) => row.key),
    ...db
      .selectDistinct({ key: panels.characterKey })
      .from(panels)
      .all()
      .map((row) => row.key),
    ...db
      .select({ key: memoryScopes.owner })
      .from(memoryScopes)
      .where(eq(memoryScopes.slot, 'character'))
      .all()
      .map((row) => row.key),
  ]);
}

/**
 * Move everything stored for this character under older keys to `key`: the
 * same GUID with another realm or name, or keys saved before GUIDs with the
 * same game and name. Where a routine, panel or memory entry already exists
 * under `key`, the current one wins and the older copy is dropped.
 * Returns the keys that were merged.
 */
export function adoptCharacterKey(db: ApplicationOrm, key: string): string[] {
  const merged = [...storedKeys(db)].filter(
    (stored): stored is string => !!stored && stored !== key && sameCharacter(stored, key),
  );
  for (const from of merged) {
    db.update(chats).set({ characterKey: key }).where(eq(chats.characterKey, from)).run();
    db.update(routineRuns)
      .set({ characterKey: key })
      .where(eq(routineRuns.characterKey, from))
      .run();
    for (const table of [routines, panels]) {
      const taken = new Set(
        db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.characterKey, key))
          .all()
          .map((row) => row.id),
      );
      for (const { id } of db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.characterKey, from))
        .all()) {
        const row = and(eq(table.characterKey, from), eq(table.id, id));
        if (taken.has(id)) {
          db.delete(table).where(row).run();
        } else {
          db.update(table).set({ characterKey: key }).where(row).run();
        }
      }
    }
    const scope = db
      .select()
      .from(memoryScopes)
      .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)))
      .get();
    if (scope) {
      db.insert(memoryScopes)
        .values({ ...scope, owner: key })
        .onConflictDoNothing()
        .run();
      const owned = (owner: string) =>
        and(eq(memoryEntries.slot, 'character'), eq(memoryEntries.owner, owner));
      const taken = new Set(
        db
          .select({ key: memoryEntries.key })
          .from(memoryEntries)
          .where(owned(key))
          .all()
          .map((row) => row.key),
      );
      for (const entry of db.select().from(memoryEntries).where(owned(from)).all()) {
        if (!taken.has(entry.key)) {
          db.insert(memoryEntries)
            .values({ ...entry, owner: key })
            .run();
        }
      }
      db.delete(memoryEntries).where(owned(from)).run();
      db.delete(memoryScopes)
        .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)))
        .run();
    }
  }
  return merged;
}
