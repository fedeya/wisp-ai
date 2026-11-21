import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { savedRoutine } from '@wisp/protocol/routines';
import { databaseScope } from './database-fixture.ts';
import { adoptCharacterKey } from '../src/db/character-keys.ts';
import {
  importRoutines,
  readMemory,
  readPanels,
  saveMemory,
  savePanels,
} from '../src/db/product-store.ts';
import { chats, routineRuns, routines } from '../src/db/schema.ts';
import { createCharacterAdoption } from '../src/chat/character-adoption.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

const key = (...parts: string[]) => JSON.stringify(['WoW Forever', ...parts]);
const oldRealm = key('CAMWOW US2 Realm 2 PvP', 'Fedrath');
const otherRealm = key('Old Realm', 'Fedrath');
const someoneElse = key('CAMWOW US2 Realm 2 PvP', 'Mage');
const renamed = key('', 'Fedrath Old', 'Player-1-00A');
const current = key('', 'Fedrath', 'Player-1-00A');
const otherGuid = key('', 'Fedrath', 'Player-1-00B');

const routine = (id: string, characterKey: string) =>
  savedRoutine.parse({
    id,
    title: id,
    instruction: 'Check',
    triggers: [{ kind: 'interval', seconds: 60 }],
    characterKey,
    enabled: true,
    updatedAt: 1,
    nextAt: 1,
  });
const panel = (id: string, characterKey: string, title = id) => ({
  id,
  characterKey,
  title,
  updatedAt: 1,
  ui: [{ id: 'card', kind: 'card' as const, title }],
  references: {},
  bindings: [],
});
const memory = (entryKey: string, text: string) => ({
  key: entryKey,
  text,
  updatedAt: '2026-11-01',
});

async function withDatabase(
  work: (database: ReturnType<ReturnType<typeof databaseScope>['open']>) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wisp-character-keys-'));
  const scope = databaseScope();
  try {
    const database = scope.open(path.join(dir, 'wisp.sqlite'));
    await database.initializeProducts();
    await work(database);
  } finally {
    await scope.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('a character with a GUID adopts every older key for it and keeps current data on conflicts', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) => {
      importRoutines(db, {
        routines: [
          routine('daily', oldRealm),
          routine('shared', otherRealm),
          routine('shared', current),
          routine('mage', someoneElse),
          routine('alt', otherGuid),
        ],
        runs: [
          {
            id: 'run-1',
            characterKey: oldRealm,
            routineId: 'daily',
            title: 'daily',
            startedAt: 1,
            event: 'interval',
            status: 'done',
          },
        ],
      });
      savePanels(db, [
        panel('goal', renamed, 'Old goal'),
        panel('goal', current, 'Current goal'),
        panel('farm', oldRealm),
      ]);
      saveMemory(db, 'character', oldRealm, [memory('spec', 'Old spec'), memory('pet', 'Wolf')]);
      saveMemory(db, 'character', current, [memory('spec', 'Frost')]);
      db.insert(chats)
        .values(
          [oldRealm, someoneElse].map((characterKey, sortIndex) => ({
            id: 'chat-' + sortIndex,
            sortIndex,
            title: 'Chat',
            status: 'done' as const,
            characterKey,
            revision: 0,
            extras: '{}',
          })),
        )
        .run();
    });

    const merged = await database.transaction((db) => adoptCharacterKey(db, current));
    expect(merged.sort()).toEqual([oldRealm, otherRealm, renamed].sort());

    const db = database.orm;
    const owned = (table: typeof routines) =>
      db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.characterKey, current))
        .all()
        .map((row) => row.id)
        .sort();
    expect(owned(routines)).toEqual(['daily', 'shared']);
    expect(
      db
        .select({ key: routines.characterKey })
        .from(routines)
        .all()
        .map((row) => row.key)
        .sort(),
    ).toEqual([current, current, otherGuid, someoneElse].sort());
    expect(db.select().from(routineRuns).get()?.characterKey).toBe(current);
    expect(
      readPanels(db)
        .map((p) => [p.characterKey, p.id, p.title])
        .sort(),
    ).toEqual([
      [current, 'farm', 'farm'],
      [current, 'goal', 'Current goal'],
    ]);
    expect(
      readMemory(db, 'character', current)
        .map((m) => [m.key, m.text])
        .sort(),
    ).toEqual([
      ['pet', 'Wolf'],
      ['spec', 'Frost'],
    ]);
    expect(readMemory(db, 'character', oldRealm)).toEqual([]);
    expect(
      db
        .select({ key: chats.characterKey })
        .from(chats)
        .all()
        .map((row) => row.key),
    ).toEqual([current, someoneElse]);

    expect(await database.transaction((db) => adoptCharacterKey(db, current))).toEqual([]);
  });
});

test('adoption moves in-memory chats, reloads panels and runs once per key', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) => savePanels(db, [panel('farm', oldRealm)]));
    const chat = { ...newChat('chat', 'addon'), characterKey: oldRealm };
    const other = { ...newChat('other', 'addon'), characterKey: someoneElse };
    let reloads = 0,
      changes = 0;
    const adopt = createCharacterAdoption({
      database,
      panelStore: { reload: async () => void reloads++ },
      chats: () => [chat, other],
      changed: () => void changes++,
      logger: { info: () => {}, warn: () => {} },
    });
    await adopt(oldRealm);
    expect(reloads).toBe(0);
    await adopt(current);
    await adopt(current);
    expect(chat.characterKey).toBe(current);
    expect(other.characterKey).toBe(someoneElse);
    expect(readPanels(database.orm).map((p) => p.characterKey)).toEqual([current]);
    expect([reloads, changes]).toEqual([1, 1]);
  });
});
