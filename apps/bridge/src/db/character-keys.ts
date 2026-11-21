import { and, eq } from 'drizzle-orm';
import { parseCharacterKey, sameCharacter } from '@wisp/protocol/character-key';
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
 * The stored keys whose data belongs to the character `key` names:
 * - keys with the same GUID (its realm or name changed);
 * - pre-GUID keys with an empty realm and the same game and name;
 * - pre-GUID keys with a realm and the same game and name, but only when a
 *   single realm has that name. WoW Forever reuses names across its PvP and
 *   PvE servers, and an empty realm can no longer tell which one is current.
 */
export function adoptableKeys(stored: Iterable<string | null | undefined>, key: string): string[] {
  const candidates = [...new Set(stored)].filter(
    (k): k is string => !!k && k !== key && sameCharacter(k, key),
  );
  const realms = new Set(
    candidates
      .map((k) => parseCharacterKey(k))
      .flatMap((c) => (!c.guid && c.realm ? [c.realm] : [])),
  );
  return candidates.filter((k) => {
    const c = parseCharacterKey(k);
    return c.guid || !c.realm || realms.size === 1;
  });
}

/**
 * Move everything stored for this character under older keys (see
 * `adoptableKeys`) to `key`. `extra` adds keys only held in memory, such as
 * unsaved chats. Where a routine, panel or memory entry already exists under
 * `key`, the current one wins and the older copy is dropped.
 * Returns the keys that were merged.
 */
export function adoptCharacterKey(
  db: ApplicationOrm,
  key: string,
  extra: Iterable<string | undefined> = [],
): string[] {
  const merged = adoptableKeys([...storedKeys(db), ...extra], key);
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
