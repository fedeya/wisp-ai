import { and, eq, like } from 'drizzle-orm';
import { adoptableKeys, characterName, type CharacterName } from '@wisp/protocol/character-key';
import { Effect } from 'effect';
import type { SqlExecutor } from '@wisp/db/sql-database';
import {
  chats,
  memoryEntries,
  memoryScopes,
  metadata,
  panels,
  routineRuns,
  routines,
} from '@wisp/db/schema';

const storedKeys = Effect.fnUntraced(function* (db: SqlExecutor) {
  const keys = (rows: { key: string | null }[]) => rows.map((row) => row.key);
  return new Set([
    ...keys(yield* db.selectDistinct({ key: chats.characterKey }).from(chats).all()),
    ...keys(yield* db.selectDistinct({ key: routines.characterKey }).from(routines).all()),
    ...keys(yield* db.selectDistinct({ key: routineRuns.characterKey }).from(routineRuns).all()),
    ...keys(yield* db.selectDistinct({ key: panels.characterKey }).from(panels).all()),
    ...keys(
      yield* db
        .select({ key: memoryScopes.owner })
        .from(memoryScopes)
        .where(eq(memoryScopes.slot, 'character'))
        .all(),
    ),
  ]);
});

/**
 * Move everything stored under this character's pre-GUID keys (see
 * `adoptableKeys`) to its GUID `key`. `extra` adds keys only held in memory,
 * such as unsaved chats. Where a routine, panel or memory entry already exists
 * under `key`, the GUID one wins and the older copy is dropped.
 * Returns the keys that were merged.
 */
export const adoptCharacterKey = Effect.fnUntraced(function* (
  db: SqlExecutor,
  key: string,
  character: { game: string; name: string },
  extra: Iterable<string | undefined> = [],
) {
  const merged = adoptableKeys([...(yield* storedKeys(db)), ...extra], character);
  for (const from of merged) {
    yield* db.update(chats).set({ characterKey: key }).where(eq(chats.characterKey, from)).run();
    yield* db
      .update(routineRuns)
      .set({ characterKey: key })
      .where(eq(routineRuns.characterKey, from))
      .run();
    for (const table of [routines, panels]) {
      const taken = new Set(
        (yield* db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.characterKey, key))
          .all()).map((row) => row.id),
      );
      for (const { id, content } of yield* db
        .select({ id: table.id, content: table.content })
        .from(table)
        .where(eq(table.characterKey, from))
        .all()) {
        const row = and(eq(table.characterKey, from), eq(table.id, id));
        if (taken.has(id)) {
          yield* db.delete(table).where(row).run();
        } else {
          // Panels remember the key they came from, so the addon can move
          // their saved layout from exactly that key.
          const moved =
            table === panels
              ? { content: JSON.stringify({ ...JSON.parse(content), formerKey: from }) }
              : {};
          yield* db
            .update(table)
            .set({ characterKey: key, ...moved })
            .where(row)
            .run();
        }
      }
    }
    const scope = yield* db
      .select()
      .from(memoryScopes)
      .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)))
      .get();
    if (scope) {
      yield* db
        .insert(memoryScopes)
        .values({ ...scope, owner: key })
        .onConflictDoNothing()
        .run();
      const owned = (owner: string) =>
        and(eq(memoryEntries.slot, 'character'), eq(memoryEntries.owner, owner));
      const taken = new Set(
        (yield* db
          .select({ key: memoryEntries.key })
          .from(memoryEntries)
          .where(owned(key))
          .all()).map((row) => row.key),
      );
      for (const entry of yield* db.select().from(memoryEntries).where(owned(from)).all()) {
        if (!taken.has(entry.key)) {
          yield* db
            .insert(memoryEntries)
            .values({ ...entry, owner: key })
            .run();
        }
      }
      yield* db.delete(memoryEntries).where(owned(from)).run();
      yield* db
        .delete(memoryScopes)
        .where(and(eq(memoryScopes.slot, 'character'), eq(memoryScopes.owner, from)))
        .run();
    }
  }
  return merged;
});

// GUID keys carry no name, so the bridge keeps the latest one for labels.
const namePrefix = 'character-name:';
export const saveCharacterName = (db: SqlExecutor, key: string, name: CharacterName) => {
  const value = JSON.stringify({ name: name.name, realm: name.realm });
  return db
    .insert(metadata)
    .values({ key: namePrefix + key, value })
    .onConflictDoUpdate({ target: metadata.key, set: { value } })
    .run();
};
export const readCharacterNames = (db: SqlExecutor) =>
  db
    .select()
    .from(metadata)
    .where(like(metadata.key, namePrefix + '%'))
    .all()
    .pipe(
      Effect.map((rows): Record<string, CharacterName> =>
        Object.fromEntries(
          rows.flatMap((row) => {
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
        ),
      ),
    );
