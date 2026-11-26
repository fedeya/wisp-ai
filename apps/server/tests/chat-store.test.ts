import { test, expect, vi } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { chatsAt, testDirectory, TestDirectory } from './storage-fixture.ts';
import { migrateDesktop } from '../src/migrations/desktop.ts';

function chat(id = 'chat') {
  return { ...newChat(id, 'game'), messages: [{ role: 'user' as const, text: 'Hello' }] };
}
/** A test directory whose `store()` opens the conversation store over its database. */
const withChats = <A, E, R>(
  work: (f: {
    root: string;
    file: string;
    legacy: string;
    store: () => ReturnType<typeof chatsAt>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { root, file } = yield* TestDirectory;
    return yield* work({
      root,
      file,
      legacy: path.join(root, 'chats.json'),
      store: () =>
        chatsAt(file, {
          onError: (error) => {
            throw error;
          },
        }),
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
    Effect.scoped,
    Effect.provide(testDirectory),
  );
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

it.live('imports complete rich history once and retains byte-for-byte legacy backups', () =>
  withChats((f) =>
    Effect.gen(function* () {
      const original = [
        {
          ...chat(),
          characterKey: '["Forever","Realm","Mage"]',
          agentSession: 'session',
          modelSettings: { model: 'luna', effort: 'high' },
          futureMetadata: { keep: true },
          messages: [
            {
              role: 'assistant',
              id: 'answer',
              text: 'Hola 🧙\n世界',
              ui: [{ id: 'detail', kind: 'text', text: 'Details' }],
              parts: [
                { type: 'text', text: 'Hola' },
                { type: 'ui', id: 'detail' },
              ],
              references: {},
              futureMessageMetadata: [1, 2, 3],
            },
          ],
        },
      ];
      const bytes = JSON.stringify(original, null, 3) + '\n';
      yield* Effect.promise(async () => writeFile(f.legacy, bytes));
      const store = yield* f.store();
      const loaded = yield* store.load();
      expect(loaded[0]).toMatchObject(original[0]);
      expect(yield* Effect.promise(async () => readFile(f.legacy, 'utf8'))).toBe(bytes);
      const backups = (yield* Effect.promise(async () => readdir(f.root))).filter((name) =>
        name.startsWith('chats.pre-sqlite-'),
      );
      expect(backups).toHaveLength(1);
      expect(
        yield* Effect.promise(async () => readFile(path.join(f.root, backups[0]), 'utf8')),
      ).toBe(bytes);
      expect(
        inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM messages').get()!.n),
      ).toBe(1);
      loaded[0].title = 'Saved in SQLite';
      yield* store.flush(loaded);
      yield* store.close();
      // A stale or corrupt JSON cannot replace the successfully imported database.
      yield* Effect.promise(async () => writeFile(f.legacy, '{stale and broken'));
      const reopened = yield* f.store();
      expect((yield* reopened.load())[0].title).toBe('Saved in SQLite');
      yield* reopened.flush([]);
      yield* reopened.close();
      expect(yield* (yield* f.store()).load()).toEqual([]);
    }),
  ),
);

test.each([
  '{broken',
  JSON.stringify([chat(), { ...chat('bad'), messages: [{ role: 'assistant', text: 42 }] }]),
  JSON.stringify([chat(), chat()]),
])('invalid or duplicate legacy history is preserved without partial import: %s', (bytes) =>
  Effect.runPromise(
    withChats((f) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => writeFile(f.legacy, bytes));
        const store = yield* f.store();
        expect((yield* Effect.flip(store.load())).message).toContain('preserved');
        expect((yield* Effect.flip(store.flush([]))).message).toContain('Load conversations');
        expect(yield* Effect.promise(async () => readFile(f.legacy, 'utf8'))).toBe(bytes);
        expect(
          inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chats').get()!.n),
        ).toBe(0);
        // Correcting the source permits a clean retry after the failed import.
        yield* Effect.promise(async () => writeFile(f.legacy, JSON.stringify([chat()])));
        expect(yield* (yield* f.store()).load()).toHaveLength(1);
      }),
    ),
  ),
);

it.live('a failed migration rolls back all rows and retries with the existing backup', () =>
  withChats((f) =>
    Effect.gen(function* () {
      const initial = yield* f.store();
      yield* initial.load();
      yield* initial.close();
      inspect(f.file, (db) =>
        db.exec(`DELETE FROM metadata;
      CREATE TRIGGER inject_failure BEFORE INSERT ON messages WHEN NEW.position = 1
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`),
      );
      const original = chat();
      original.messages.push({ role: 'user', text: 'Second message' });
      yield* Effect.promise(async () => writeFile(f.legacy, JSON.stringify([original])));
      expect(
        (yield* Effect.flip(Effect.flatMap(f.store(), (store) => store.load()))).message,
      ).toContain('preserved');
      expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chats').get()!.n)).toBe(
        0,
      );
      expect(
        inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM metadata').get()!.n),
      ).toBe(0);
      inspect(f.file, (db) => db.exec('DROP TRIGGER inject_failure'));
      expect((yield* (yield* f.store()).load())[0].messages).toEqual(original.messages);
      expect(
        (yield* Effect.promise(async () => readdir(f.root))).filter((name) =>
          name.startsWith('chats.pre-sqlite-'),
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.live('empty drafts are neither restored nor saved; deletion cascades to messages', () =>
  withChats((f) =>
    Effect.gen(function* () {
      const draft = newChat('draft', 'game');
      yield* Effect.promise(async () => writeFile(f.legacy, JSON.stringify([draft, chat()])));
      const store = yield* f.store();
      expect((yield* store.load()).map((c) => c.id)).toEqual(['chat']);
      yield* store.flush([draft, chat()]);
      expect(inspect(f.file, (db) => db.prepare('SELECT id FROM chats').all())).toEqual([
        { id: 'chat' },
      ]);
      yield* store.flush([]);
      expect(
        inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM messages').get()!.n),
      ).toBe(0);
    }),
  ),
);

it.live('restart interrupts active turns and queued saves capture independent snapshots', () =>
  withChats((f) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () =>
        writeFile(
          f.legacy,
          JSON.stringify([
            {
              ...chat(),
              status: 'working',
              activity: [{ id: 'call', name: 'query_character', label: 'Read', status: 'running' }],
              messages: [
                { role: 'user', text: 'Hello' },
                {
                  id: 'tool-call',
                  role: 'tool',
                  text: 'Read',
                  tool: { id: 'call', name: 'query_character', label: 'Read', status: 'running' },
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 0,
                compactions: 0,
                compacting: true,
              },
            },
          ]),
        ),
      );
      const store = yield* f.store();
      const chats = yield* store.load();
      expect(chats[0].status).toBe('interrupted');
      expect(chats[0].usage!.compacting).toBe(false);
      // The calls died with the turn; none is left running.
      expect(chats[0].messages[1]?.tool?.status).toBe('cancelled');
      expect(chats[0].activity.map(({ status }) => status)).not.toContain('running');
      const first = yield* Effect.forkChild(store.flush(chats));
      chats[0].title = 'Latest';
      yield* store.flush(chats);
      yield* Fiber.join(first);
      yield* store.close();
      expect((yield* (yield* f.store()).load())[0].title).toBe('Latest');
    }),
  ),
);

it.live('streaming writes update only changed messages and preserve other conversations', () =>
  withChats((f) =>
    Effect.gen(function* () {
      const store = yield* f.store();
      yield* store.load();
      const chats = [chat(), chat('other')];
      yield* store.flush(chats);
      inspect(f.file, (db) =>
        db.exec(`CREATE TABLE changed_messages(chat_id TEXT);
      CREATE TRIGGER message_updates AFTER UPDATE ON messages
      BEGIN INSERT INTO changed_messages VALUES(NEW.chat_id); END;`),
      );
      vi.useFakeTimers();
      chats[0].messages[0].text = 'Streaming update';
      store.schedule(() => chats);
      store.schedule(() => chats);
      yield* Effect.promise(async () => vi.advanceTimersByTimeAsync(1000));
      yield* store.flush(chats);
      expect(inspect(f.file, (db) => db.prepare('SELECT * FROM changed_messages').all())).toEqual([
        { chat_id: 'chat' },
      ]);
      expect(
        inspect(
          f.file,
          (db) => db.prepare("SELECT revision FROM chats WHERE id = 'other'").get()!.revision,
        ),
      ).toBe(0);
      chats[0].messages.push({ role: 'user', text: 'Appended' });
      yield* store.flush(chats);
      chats[0].messages.splice(0, 1);
      yield* store.flush(chats);
      yield* store.close();
      expect((yield* (yield* f.store()).load())[0].messages).toEqual(chats[0].messages);
    }),
  ),
);

it.live('stale writes fail atomically instead of overwriting another connection', () =>
  withChats((f) =>
    Effect.gen(function* () {
      const first = yield* f.store();
      yield* first.load();
      yield* first.flush([chat(), chat('other')]);
      const stale = yield* f.store();
      const old = yield* stale.load();
      const latest = [chat(), chat('other')];
      latest[0].title = 'Committed';
      yield* first.flush(latest);
      old[1].title = 'Must roll back';
      old[0].title = 'Stale';
      expect((yield* Effect.flip(stale.flush(old.reverse()))).message).toContain('another process');
      const stored = yield* (yield* f.store()).load();
      expect(stored[0].title).toBe('Committed');
      expect(stored[1].title).toBe('New conversation');
    }),
  ),
);

test.each(['incompatible schema', 'corrupt database'])(
  'refuses %s instead of silently falling back to JSON',
  (kind) =>
    Effect.runPromise(
      withChats((f) =>
        Effect.gen(function* () {
          if (kind === 'incompatible schema') {
            inspect(f.file, (db) =>
              db.exec(
                "CREATE TABLE chats(id TEXT PRIMARY KEY, title TEXT); INSERT INTO chats VALUES ('keep', 'original')",
              ),
            );
          } else {
            yield* Effect.promise(async () => writeFile(f.file, 'not a SQLite file'));
          }
          const original = yield* Effect.promise(async () => readFile(f.file));
          yield* Effect.promise(async () => writeFile(f.legacy, JSON.stringify([chat()])));
          // The database refuses to open; the legacy JSON is not used in its place.
          expect(
            (yield* Effect.flip(Effect.flatMap(f.store(), (store) => store.load()))).message,
          ).toMatch(/application database/);
          if (kind === 'incompatible schema') {
            expect(inspect(f.file, (db) => db.prepare('SELECT * FROM chats').all())).toEqual([
              { id: 'keep', title: 'original' },
            ]);
          } else {
            expect(yield* Effect.promise(async () => readFile(f.file))).toEqual(original);
          }
        }),
      ),
    ),
);

it.live(
  'installation import replaces an empty workspace and snapshots WAL data without modifying the source',
  () =>
    withChats((f) =>
      Effect.gen(function* () {
        const source = path.join(f.root, 'old');
        const destination = path.join(f.root, 'new');
        yield* Effect.promise(async () =>
          writeFile(path.join(f.root, 'config.local.json'), JSON.stringify({ wow: 'test' })),
        );
        const sourceStore = yield* chatsAt(path.join(source, 'runtime/wisp.sqlite'));
        yield* sourceStore.load();
        const original = { ...chat(), agentSession: 'source-session', status: 'working' as const };
        yield* sourceStore.flush([original]);
        yield* Effect.promise(async () =>
          writeFile(
            path.join(source, 'runtime/chats.json'),
            '{stale JSON must not override SQLite',
          ),
        );
        yield* Effect.promise(async () =>
          writeFile(path.join(source, 'config.local.json'), JSON.stringify({ wow: 'test' })),
        );
        const empty = yield* chatsAt(path.join(destination, 'runtime/wisp.sqlite'));
        yield* empty.load();
        yield* empty.close();
        yield* Effect.promise(async () =>
          writeFile(path.join(destination, 'runtime/chatgpt-host.json'), 'new host'),
        );
        yield* Effect.promise(async () =>
          writeFile(path.join(source, 'runtime/chatgpt-host.json'), 'old host'),
        );
        // No desktop endpoint: source DB remains open with committed WAL pages.
        yield* Effect.promise(async () => migrateDesktop(source, destination, ''));
        expect(
          yield* Effect.promise(async () =>
            readFile(path.join(destination, 'runtime/chatgpt-host.json'), 'utf8'),
          ),
        ).toBe('old host');
        const imported = yield* chatsAt(path.join(destination, 'runtime/wisp.sqlite'));
        try {
          const chats = yield* imported.load();
          expect(chats[0].agentSession).toBeUndefined();
          expect(chats[0].status).toBe('interrupted');
          expect(chats[0].messages).toEqual(original.messages);
        } finally {
          yield* imported.close();
        }
        expect(
          inspect(
            path.join(source, 'runtime/wisp.sqlite'),
            (db) =>
              db.prepare('SELECT agent_session FROM chat_instance_state').get()!.agent_session,
          ),
        ).toBe('source-session');
      }),
    ),
);
