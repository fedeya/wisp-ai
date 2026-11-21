import { and, eq } from 'drizzle-orm';
import { adoptableKeys } from '@wisp/protocol/character-key';
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
 * Where adopted character keys went. Writes queued before an adoption still
 * name the old key; resolving it inside their transaction sends them to the
 * key that now holds the data.
 */
export class CharacterKeyAliases {
  private aliases = new Map<string, string>();
  record(from: Iterable<string>, to: string) {
    this.aliases.delete(to);
    for (const key of from) {
      if (key !== to) this.aliases.set(key, to);
    }
  }
  resolve(key: string): string {
    const seen = new Set<string>();
    while (this.aliases.has(key) && !seen.has(key)) {
      seen.add(key);
      key = this.aliases.get(key)!;
    }
    return key;
  }
}

const maxFormerKeys = 8;
function withFormerKey(content: string, from: string) {
  const panel = JSON.parse(content) as { formerKeys?: unknown };
  const earlier = Array.isArray(panel.formerKeys)
    ? panel.formerKeys.filter((k): k is string => typeof k === 'string' && k !== from)
    : [];
  return JSON.stringify({ ...panel, formerKeys: [...earlier, from].slice(-maxFormerKeys) });
}

/**
 * Move everything stored for this character under older keys (see
 * `adoptableKeys` in `@wisp/protocol/character-key`) to `key`. `extra` adds keys only held in memory, such as
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
      for (const { id, content } of db
        .select({ id: table.id, content: table.content })
        .from(table)
        .where(eq(table.characterKey, from))
        .all()) {
        const row = and(eq(table.characterKey, from), eq(table.id, id));
        if (taken.has(id)) {
          db.delete(table).where(row).run();
        } else {
          // Panels remember every key they came from, so the addon can move
          // their saved layout from exactly those keys, even if it never saw
          // an intermediate key.
          const moved = table === panels ? { content: withFormerKey(content, from) } : {};
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
