import { test, expect } from 'vitest';
import { Effect } from 'effect';
import type { SqlDatabase, SqlExecutor } from '@wisp/db/sql-database';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { savedRoutine } from '@wisp/protocol/routines';
import { databaseScope, promised } from './database-fixture.ts';
import { adoptCharacterKey, readCharacterNames } from '../src/chat/character-keys.ts';
import { readMemory, saveMemory } from '../src/agent/memory-record.ts';
import { readPanels, savePanels } from '../src/panels/panel-record.ts';
import { importRoutines } from '../src/routines/routine-record.ts';
import { chats, metadata, routineRuns, routines } from '@wisp/db/schema';
import { createCharacterAdoption } from '../src/chat/character-adoption.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { makeMemoryStore } from '../src/agent/memory-store.ts';
import { makePanelStore } from '../src/panels/panel-store.ts';

const key = (...parts: string[]) => JSON.stringify(['WoW Forever', ...parts]);
const oldRealm = key('CAMWOW US2 Realm 2 PvP', 'Fedrath');
const noRealm = key('', 'Fedrath');
const someoneElse = key('CAMWOW US2 Realm 2 PvP', 'Mage');
const current = key('Player-1-00A');
const otherGuid = key('Player-1-00B');
const fedrath = {
  key: current,
  game: 'WoW Forever',
  realm: '',
  name: 'Fedrath',
  guid: 'Player-1-00A',
};

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

interface TestDatabase {
  service: SqlDatabase['Service'];
  /** Runs work in one transaction, as the stores do. */
  transaction: <A, E>(work: (db: SqlExecutor) => Effect.Effect<A, E>) => Promise<A>;
  /** Runs one read or write outside a transaction. */
  query: <A, E>(work: (db: SqlExecutor) => Effect.Effect<A, E>) => Promise<A>;
}

async function withDatabase(work: (database: TestDatabase) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wisp-character-keys-'));
  const scope = databaseScope();
  try {
    const service = await scope.open(path.join(dir, 'wisp.sqlite'));
    await work({
      service,
      transaction: (work) => Effect.runPromise(service.db.transaction((tx) => work(tx))),
      query: (work) => Effect.runPromise(work(service.db)),
    });
  } finally {
    await scope.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('a character with a GUID adopts its pre-GUID keys and keeps GUID data on conflicts', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) =>
      Effect.gen(function* () {
        yield* importRoutines(db, {
          routines: [
            routine('daily', oldRealm),
            routine('shared', noRealm),
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
        yield* savePanels(db, [
          panel('goal', noRealm, 'Old goal'),
          panel('goal', current, 'Current goal'),
          panel('farm', oldRealm),
        ]);
        yield* saveMemory(db, 'character', oldRealm, [
          memory('spec', 'Old spec'),
          memory('pet', 'Wolf'),
        ]);
        yield* saveMemory(db, 'character', current, [memory('spec', 'Frost')]);
        yield* db
          .insert(chats)
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
      }),
    );

    const merged = await database.transaction((db) => adoptCharacterKey(db, current, fedrath));
    expect(merged.sort()).toEqual([oldRealm, noRealm].sort());

    expect(
      (
        await database.query((db) =>
          db.select({ key: routines.characterKey, id: routines.id }).from(routines).all(),
        )
      )
        .map((row) => [row.key, row.id])
        .sort(),
    ).toEqual(
      [
        [current, 'daily'],
        [current, 'shared'],
        [someoneElse, 'mage'],
        [otherGuid, 'alt'],
      ].sort(),
    );
    expect((await database.query((db) => db.select().from(routineRuns).get()))?.characterKey).toBe(
      current,
    );
    expect(
      (await database.query(readPanels))
        .map((p) => [p.characterKey, p.id, p.title, p.formerKey])
        .sort(),
    ).toEqual([
      [current, 'farm', 'farm', oldRealm],
      [current, 'goal', 'Current goal', undefined],
    ]);
    expect(
      (await database.query((db) => readMemory(db, 'character', current)))
        .map((m) => [m.key, m.text])
        .sort(),
    ).toEqual([
      ['pet', 'Wolf'],
      ['spec', 'Frost'],
    ]);
    expect(await database.query((db) => readMemory(db, 'character', oldRealm))).toEqual([]);
    expect(
      (await database.query((db) => db.select({ key: chats.characterKey }).from(chats).all()))
        .map((row) => row.key)
        .sort(),
    ).toEqual([current, someoneElse].sort());

    expect(await database.transaction((db) => adoptCharacterKey(db, current, fedrath))).toEqual([]);
  });
});

test('a name saved on several realms stays put, since the empty realm cannot pick one', async () => {
  const pvp = key('Realm 2 PvP', 'Fedrath');
  const pve = key('Realm 1 PvE', 'Fedrath');
  await withDatabase(async (database) => {
    await database.transaction((db) =>
      savePanels(db, [panel('a', pvp), panel('b', pve), panel('c', noRealm)]),
    );
    expect(await database.transaction((db) => adoptCharacterKey(db, current, fedrath))).toEqual([
      noRealm,
    ]);
    expect((await database.query(readPanels)).map((p) => [p.id, p.characterKey]).sort()).toEqual([
      ['a', pvp],
      ['b', pve],
      ['c', current],
    ]);
  });
});

test('adoption saves the name, moves in-memory chats and runs once per character', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) => savePanels(db, [panel('farm', oldRealm)]));
    const chat = { ...newChat('unsaved', 'addon'), characterKey: noRealm };
    const other = { ...newChat('other', 'addon'), characterKey: someoneElse };
    let changes = 0;
    const adoptCharacter = createCharacterAdoption({
      database: database.service,
      chats: () => [chat, other],
      changed: () => void changes++,
    });
    const adopt = (character: Parameters<typeof adoptCharacter>[0]) =>
      Effect.runPromise(adoptCharacter(character));
    await adopt({ ...fedrath, key: oldRealm, guid: undefined });
    expect(changes).toBe(0);
    await adopt(fedrath);
    await adopt(fedrath);
    expect([chat.characterKey, other.characterKey]).toEqual([current, someoneElse]);
    expect((await database.query(readPanels)).map((p) => p.characterKey)).toEqual([current]);
    expect(await database.query(readCharacterNames)).toEqual({
      [current]: { name: 'Fedrath', realm: '' },
    });
    expect(changes).toBe(1);

    // A damaged name row is skipped instead of breaking every label.
    await database.query((db) =>
      db.insert(metadata).values({ key: 'character-name:broken', value: '{' }).run(),
    );
    expect(Object.keys(await database.query(readCharacterNames))).toEqual([current]);

    // A rename keeps the key and only updates the saved name.
    await adopt({ ...fedrath, name: 'Fedrath Vorn' });
    expect((await database.query(readCharacterNames))[current]).toEqual({
      name: 'Fedrath Vorn',
      realm: '',
    });
    expect(changes).toBe(2);
  });
});

test('memory merged over quota can still be trimmed but not grown', async () => {
  await withDatabase(async (database) => {
    const entries = Array.from({ length: 42 }, (_, i) => memory('k' + i, 'note ' + i));
    await database.transaction((db) => saveMemory(db, 'character', current, entries));
    const store = promised(makeMemoryStore(database.service));
    await expect(store.update('character', current, 'extra', 'more')).rejects.toThrow(
      'Memory is full',
    );
    await expect(store.update('character', current, 'k0', 'a much longer note 0')).rejects.toThrow(
      'Memory is full',
    );
    expect(await store.update('character', current, 'k1', 'n')).toHaveLength(42);
    expect(await store.update('character', current, 'k0')).toHaveLength(41);
  });
});

test('editing an adopted panel keeps the key it was moved from', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) => savePanels(db, [panel('farm', oldRealm)]));
    await database.transaction((db) => adoptCharacterKey(db, current, fedrath));
    const store = promised(makePanelStore(database.service));
    const [saved] = await store.mutate(current, {
      operation: 'save',
      panel: panel('farm', current, 'Renamed farm'),
    });
    expect([saved.title, saved.formerKey]).toEqual(['Renamed farm', oldRealm]);
    expect((await database.query(readPanels))[0].formerKey).toEqual(oldRealm);
  });
});

test('panels merged past the limit can be edited but not added to', async () => {
  await withDatabase(async (database) => {
    await database.transaction((db) =>
      savePanels(
        db,
        Array.from({ length: 13 }, (_, i) => panel('p' + i, current)),
      ),
    );
    const store = promised(makePanelStore(database.service));
    const edited = await store.mutate(current, {
      operation: 'save',
      panel: panel('p0', current, 'Edited'),
    });
    expect(edited.find((p) => p.id === 'p0')?.title).toBe('Edited');
    await expect(
      store.mutate(current, { operation: 'save', panel: panel('new', current) }),
    ).rejects.toThrow('Keep at most 12 panels per character');
  });
});
