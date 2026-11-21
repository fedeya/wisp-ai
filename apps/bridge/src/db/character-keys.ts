import { and, eq, like } from 'drizzle-orm';
import { adoptableKeys, characterName, type CharacterName } from '@wisp/protocol/character-key';
import type { ApplicationOrm } from './application-database.ts';
import {
  chats,
  memoryEntries,
  memoryScopes,
  metadata,
  panels,
  routineRuns,
  routines,
} from './schema.ts';

function storedKeys(db: ApplicationOrm) {
  const keys = (rows: { key: string | null }[]) => rows.map((row) => row.key);
  return new Set([
    ...keys(db.selectDistinct({ key: chats.characterKey }).from(chats).all()),
    ...keys(db.selectDistinct({ key: routines.characterKey }).from(routines).all()),
    ...keys(db.selectDistinct({ key: routineRuns.characterKey }).from(routineRuns).all()),
    ...keys(db.selectDistinct({ key: panels.characterKey }).from(panels).all()),
    ...keys(
      db
        .select({ key: memoryScopes.owner })
        .from(memoryScopes)
        .where(eq(memoryScopes.slot, 'character'))
        .all(),
    ),
  ]);
}

/**
 * Move everything stored under this character's pre-GUID keys (see
 * `adoptableKeys`) to its GUID `key`. `extra` adds keys only held in memory,
 * such as unsaved chats. Where a routine, panel or memory entry already exists
 * under `key`, the GUID one wins and the older copy is dropped.
 * Returns the keys that were merged.
 */
export function adoptCharacterKey(
  db: ApplicationOrm,
  key: string,
  character: { game: string; name: string },
  extra: Iterable<string | undefined> = [],
): string[] {
  const merged = adoptableKeys([...storedKeys(db), ...extra], character);
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
      for (const { id, content } of db
        .select({ id: table.id, content: table.content })
        .from(table)
        .where(eq(table.characterKey, from))
        .all()) {
        const row = and(eq(table.characterKey, from), eq(table.id, id));
        if (taken.has(id)) {
          db.delete(table).where(row).run();
        } else {
          // Panels remember the key they came from, so the addon can move
          // their saved layout from exactly that key.
          const moved =
            table === panels
              ? { content: JSON.stringify({ ...JSON.parse(content), formerKey: from }) }
              : {};
          db.update(table)
            .set({ characterKey: key, ...moved })
            .where(row)
            .run();
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

// GUID keys carry no name, so the bridge keeps the latest one for labels.
const namePrefix = 'character-name:';
export function saveCharacterName(db: ApplicationOrm, key: string, name: CharacterName) {
  const value = JSON.stringify({ name: name.name, realm: name.realm });
  db.insert(metadata)
    .values({ key: namePrefix + key, value })
    .onConflictDoUpdate({ target: metadata.key, set: { value } })
    .run();
}
export function readCharacterNames(db: ApplicationOrm): Record<string, CharacterName> {
  return Object.fromEntries(
    db
      .select()
      .from(metadata)
      .where(like(metadata.key, namePrefix + '%'))
      .all()
      .flatMap((row) => {
        // A damaged row only loses its label, never the whole desktop status.
        let value: unknown;
        try {
          value = JSON.parse(row.value);
        } catch {
          return [];
        }
        const name = characterName.safeParse(value);
        return name.success ? [[row.key.slice(namePrefix.length), name.data]] : [];
      }),
  );
}
