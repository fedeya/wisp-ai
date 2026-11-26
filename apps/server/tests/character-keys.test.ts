import { expect } from 'vitest';
import { Effect } from 'effect';
import { SqlDatabase, type SqlExecutor } from '@wisp/db/sql-database';
import type { SqlFailure } from '@wisp/db/repository';
import { savedRoutine } from '@wisp/protocol/routines';
import { it } from '@effect/vitest';
import { testStorage } from './storage-fixture.ts';
import { adoptCharacterKey, readCharacterNames } from '../src/chat/character-keys.ts';
import { readMemory, saveMemory } from '../src/agent/memory-record.ts';
import { readPanels, savePanels } from '../src/panels/panel-record.ts';
import { importRoutines } from '../src/routines/routine-record.ts';
import { chats, metadata, routineRuns, routines } from '@wisp/db/schema';
import { createCharacterAdoption } from '../src/chat/character-adoption.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { MemoryStore } from '../src/agent/memory-store.ts';
import { PanelStore } from '../src/panels/panel-store.ts';

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
  /** Runs work in one transaction, as the stores do. */
  transaction: <A, E>(
    work: (db: SqlExecutor) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SqlFailure>;
  /** Runs one read or write outside a transaction. */
  query: <A, E>(work: (db: SqlExecutor) => Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** A fresh database with every store, plus direct access for seeding and reading rows. */
const withDatabase = <A, E, R>(work: (database: TestDatabase) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { db } = yield* SqlDatabase;
    return yield* work({
      transaction: (work) => db.transaction((tx) => work(tx)),
      query: (work) => work(db),
    });
  }).pipe(Effect.provide(testStorage()));

it.live('a character with a GUID adopts its pre-GUID keys and keeps GUID data on conflicts', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      yield* database.transaction((db) =>
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

      const merged = yield* database.transaction((db) => adoptCharacterKey(db, current, fedrath));
      expect(merged.sort()).toEqual([oldRealm, noRealm].sort());

      expect(
        (yield* database.query((db) =>
          db.select({ key: routines.characterKey, id: routines.id }).from(routines).all(),
        ))
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
      expect(
        (yield* database.query((db) => db.select().from(routineRuns).get()))?.characterKey,
      ).toBe(current);
      expect(
        (yield* database.query(readPanels))
          .map((p) => [p.characterKey, p.id, p.title, p.formerKey])
          .sort(),
      ).toEqual([
        [current, 'farm', 'farm', oldRealm],
        [current, 'goal', 'Current goal', undefined],
      ]);
      expect(
        (yield* database.query((db) => readMemory(db, 'character', current)))
          .map((m) => [m.key, m.text])
          .sort(),
      ).toEqual([
        ['pet', 'Wolf'],
        ['spec', 'Frost'],
      ]);
      expect(yield* database.query((db) => readMemory(db, 'character', oldRealm))).toEqual([]);
      expect(
        (yield* database.query((db) => db.select({ key: chats.characterKey }).from(chats).all()))
          .map((row) => row.key)
          .sort(),
      ).toEqual([current, someoneElse].sort());

      expect(yield* database.transaction((db) => adoptCharacterKey(db, current, fedrath))).toEqual(
        [],
      );
    }),
  ),
);

const pvp = key('Realm 2 PvP', 'Fedrath');
const pve = key('Realm 1 PvE', 'Fedrath');
it.live('a name saved on several realms stays put, since the empty realm cannot pick one', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      yield* database.transaction((db) =>
        savePanels(db, [panel('a', pvp), panel('b', pve), panel('c', noRealm)]),
      );
      expect(yield* database.transaction((db) => adoptCharacterKey(db, current, fedrath))).toEqual([
        noRealm,
      ]);
      expect((yield* database.query(readPanels)).map((p) => [p.id, p.characterKey]).sort()).toEqual(
        [
          ['a', pvp],
          ['b', pve],
          ['c', current],
        ],
      );
    }),
  ),
);

it.live('adoption saves the name, moves in-memory chats and runs once per character', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      yield* database.transaction((db) => savePanels(db, [panel('farm', oldRealm)]));
      const chat = { ...newChat('unsaved', 'addon'), characterKey: noRealm };
      const other = { ...newChat('other', 'addon'), characterKey: someoneElse };
      let changes = 0;
      const adopt = yield* createCharacterAdoption({
        chats: () => [chat, other],
        changed: () => void changes++,
      });
      yield* adopt({ ...fedrath, key: oldRealm, guid: undefined });
      expect(changes).toBe(0);
      yield* adopt(fedrath);
      yield* adopt(fedrath);
      expect([chat.characterKey, other.characterKey]).toEqual([current, someoneElse]);
      expect((yield* database.query(readPanels)).map((p) => p.characterKey)).toEqual([current]);
      expect(yield* database.query(readCharacterNames)).toEqual({
        [current]: { name: 'Fedrath', realm: '' },
      });
      expect(changes).toBe(1);

      // A damaged name row is skipped instead of breaking every label.
      yield* database.query((db) =>
        db.insert(metadata).values({ key: 'character-name:broken', value: '{' }).run(),
      );
      expect(Object.keys(yield* database.query(readCharacterNames))).toEqual([current]);

      // A rename keeps the key and only updates the saved name.
      yield* adopt({ ...fedrath, name: 'Fedrath Vorn' });
      expect((yield* database.query(readCharacterNames))[current]).toEqual({
        name: 'Fedrath Vorn',
        realm: '',
      });
      expect(changes).toBe(2);
    }),
  ),
);

it.live('memory merged over quota can still be trimmed but not grown', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const entries = Array.from({ length: 42 }, (_, i) => memory('k' + i, 'note ' + i));
      yield* database.transaction((db) => saveMemory(db, 'character', current, entries));
      const store = yield* MemoryStore;
      expect(
        (yield* Effect.flip(store.update('character', current, 'extra', 'more'))).message,
      ).toContain('Memory is full');
      expect(
        (yield* Effect.flip(store.update('character', current, 'k0', 'a much longer note 0')))
          .message,
      ).toContain('Memory is full');
      expect(yield* store.update('character', current, 'k1', 'n')).toHaveLength(42);
      expect(yield* store.update('character', current, 'k0')).toHaveLength(41);
    }),
  ),
);

it.live('editing an adopted panel keeps the key it was moved from', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      yield* database.transaction((db) => savePanels(db, [panel('farm', oldRealm)]));
      yield* database.transaction((db) => adoptCharacterKey(db, current, fedrath));
      const store = yield* PanelStore;
      const [saved] = yield* store.mutate(current, {
        operation: 'save',
        panel: panel('farm', current, 'Renamed farm'),
      });
      expect([saved.title, saved.formerKey]).toEqual(['Renamed farm', oldRealm]);
      expect((yield* database.query(readPanels))[0].formerKey).toEqual(oldRealm);
    }),
  ),
);

it.live('panels merged past the limit can be edited but not added to', () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      yield* database.transaction((db) =>
        savePanels(
          db,
          Array.from({ length: 13 }, (_, i) => panel('p' + i, current)),
        ),
      );
      const store = yield* PanelStore;
      const edited = yield* store.mutate(current, {
        operation: 'save',
        panel: panel('p0', current, 'Edited'),
      });
      expect(edited.find((p) => p.id === 'p0')?.title).toBe('Edited');
      expect(
        (yield* Effect.flip(
          store.mutate(current, { operation: 'save', panel: panel('new', current) }),
        )).message,
      ).toContain('Keep at most 12 panels per character');
    }),
  ),
);
