import { and, eq, like } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { adoptableKeys, characterName, type CharacterName } from '@wisp/protocol/character-key';
import type { ApplicationOrm } from '@wisp/db/database';
import type { SqlOrm } from '@wisp/db/sql-database';
import { chats, memoryScopes, metadata, panels, routineRuns, routines } from '@wisp/db/schema';
import { adoptMemoryOwner } from '../memory/repository.ts';

const storedKeys = Effect.fnUntraced(function* (db: SqlOrm) {
  const chatKeys = yield* db.selectDistinct({ key: chats.characterKey }).from(chats);
  const routineKeys = yield* db.selectDistinct({ key: routines.characterKey }).from(routines);
  const runKeys = yield* db.selectDistinct({ key: routineRuns.characterKey }).from(routineRuns);
  const panelKeys = yield* db.selectDistinct({ key: panels.characterKey }).from(panels);
  const memoryKeys = yield* db
    .select({ key: memoryScopes.owner })
    .from(memoryScopes)
    .where(eq(memoryScopes.slot, 'character'));
  return new Set(
    [...chatKeys, ...routineKeys, ...runKeys, ...panelKeys, ...memoryKeys].map(({ key }) => key),
  );
});

/**
 * Move everything stored under this character's pre-GUID keys (see
 * `adoptableKeys`) to its GUID `key`. `extra` adds keys only held in memory,
 * such as unsaved chats. Where a routine, panel or memory entry already exists
 * under `key`, the GUID one wins and the older copy is dropped.
 * Returns the keys that were merged.
 */
export const adoptCharacterKey = Effect.fn('CharacterKeys.adopt')(function* (
  db: SqlOrm,
  key: string,
  character: { game: string; name: string },
  extra: Iterable<string | undefined> = [],
) {
  const merged = adoptableKeys([...(yield* storedKeys(db)), ...extra], character);
  for (const from of merged) {
    yield* db.update(chats).set({ characterKey: key }).where(eq(chats.characterKey, from));
    yield* db
      .update(routineRuns)
      .set({ characterKey: key })
      .where(eq(routineRuns.characterKey, from));
    for (const table of [routines, panels]) {
      const taken = new Set(
        (yield* db.select({ id: table.id }).from(table).where(eq(table.characterKey, key))).map(
          (row) => row.id,
        ),
      );
      for (const { id, content } of yield* db
        .select({ id: table.id, content: table.content })
        .from(table)
        .where(eq(table.characterKey, from))) {
        const row = and(eq(table.characterKey, from), eq(table.id, id));
        if (taken.has(id)) {
          yield* db.delete(table).where(row);
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
            .where(row);
        }
      }
    }
    yield* adoptMemoryOwner(db, from, key);
  }
  return merged;
});

// GUID keys carry no name, so the bridge keeps the latest one for labels.
const namePrefix = 'character-name:';
const decodeStoredName = Schema.decodeOption(Schema.fromJsonString(characterName));
export function saveCharacterName(db: SqlOrm, key: string, name: CharacterName) {
  const value = JSON.stringify({ name: name.name, realm: name.realm });
  return db
    .insert(metadata)
    .values({ key: namePrefix + key, value })
    .onConflictDoUpdate({ target: metadata.key, set: { value } });
}
export function readCharacterNames(db: ApplicationOrm): Record<string, CharacterName> {
  return Object.fromEntries(
    db
      .select()
      .from(metadata)
      .where(like(metadata.key, namePrefix + '%'))
      .all()
      .flatMap((row): Array<[string, CharacterName]> =>
        // A damaged row only loses its label, never the whole desktop status.
        Option.match(decodeStoredName(row.value), {
          onNone: () => [],
          onSome: (name) => [[row.key.slice(namePrefix.length), name]],
        }),
      ),
  );
}
