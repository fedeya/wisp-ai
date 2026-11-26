import { test, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatsAt, testDirectory, TestDirectory } from './storage-fixture.ts';
import type { Chat } from '../src/chat/chat.ts';

function history(): Chat {
  return {
    ...newChat('rich', 'old-game'),
    title: 'Preserve 🧙 世界',
    characterKey: 'character',
    agentSession: 'private-session',
    unread: false,
    lastUsedAt: 123.25,
    modelSettings: { model: 'connection:old:model', effort: 'high' },
    lastUIResult: true,
    messages: [
      { role: 'user', text: 'One' },
      {
        id: 'duplicate',
        role: 'assistant',
        text: 'Two',
        references: {},
        parts: [{ type: 'text', text: 'Two' }],
      },
      { id: 'duplicate', role: 'system', text: 'Three' },
      { id: '', role: 'tool', text: 'Four' },
    ],
  };
}
const withFixture = <A, E, R>(
  work: (f: {
    root: string;
    file: string;
    store: (instanceId?: string) => ReturnType<typeof chatsAt>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { root, file } = yield* TestDirectory;
    return yield* work({ root, file, store: (instanceId) => chatsAt(file, { instanceId }) });
  }).pipe(Effect.scoped, Effect.provide(testDirectory));
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
it.live('JSON import preserves rich history and assigns stable storage IDs', () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const original = {
        ...history(),
        futureMetadata: { keep: true },
        messages: history().messages.map((m) => ({ ...m, futureField: ['keep', 1] })),
      };
      yield* Effect.promise(async () =>
        writeFile(path.join(f.root, 'chats.json'), JSON.stringify([original])),
      );
      const store = yield* f.store();
      const loaded = yield* store.load();
      expect(loaded[0]).toMatchObject(original);
      expect(loaded[0].messages).toEqual(original.messages);
      const ids = inspect(f.file, (db) =>
        db.prepare('SELECT id FROM messages ORDER BY position').all(),
      );
      expect(new Set(ids.map((r) => r.id)).size).toBe(4);
      expect(
        inspect(f.file, (db) =>
          db.prepare('SELECT title,status,character_key,last_used_at,extras FROM chats').get(),
        ),
      ).toMatchObject({
        title: original.title,
        status: 'idle',
        character_key: 'character',
        last_used_at: 123.25,
      });
      const extras = JSON.parse(
        String(inspect(f.file, (db) => db.prepare('SELECT extras FROM chats').get()!.extras)),
      );
      expect(extras).toEqual({ activity: [], futureMetadata: { keep: true } });
      expect(
        inspect(f.file, (db) =>
          db.prepare('SELECT source_id FROM messages ORDER BY position').all(),
        ).map((r) => r.source_id),
      ).toEqual([null, 'duplicate', 'duplicate', '']);
      yield* store.flush(loaded);
      yield* store.close();
      expect((yield* (yield* f.store()).load())[0]).toMatchObject(original);
      expect(
        inspect(f.file, (db) => db.prepare('SELECT id FROM messages ORDER BY position').all()),
      ).toEqual(ids);
    }),
  ),
);

it.live('message identities survive edits, insertion, reordering, deletion and reopening', () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const store = yield* f.store();
      yield* store.load();
      const chat = history();
      yield* store.flush([chat]);
      const rows = () =>
        inspect(f.file, (db) => db.prepare('SELECT id,text FROM messages ORDER BY position').all());
      const before = rows();
      chat.messages[0].text = 'Edited';
      chat.messages.reverse();
      chat.messages.splice(1, 0, { role: 'user', text: 'Inserted' });
      yield* store.flush([chat]);
      const changed = rows();
      expect(changed.map((r) => r.id)).toEqual([
        before[3].id,
        expect.any(String),
        before[2].id,
        before[1].id,
        before[0].id,
      ]);
      const stable = changed.map((r) => r.id);
      // New object wrappers with identical content retain the same storage IDs.
      chat.messages = JSON.parse(JSON.stringify(chat.messages));
      yield* store.flush([chat]);
      expect(rows().map((r) => r.id)).toEqual(stable);
      chat.messages.splice(1, 1);
      yield* store.flush([chat]);
      yield* store.close();
      expect((yield* (yield* f.store()).load())[0].messages).toEqual(chat.messages);
      expect(rows().map((r) => r.id)).toEqual([
        before[3].id,
        before[2].id,
        before[1].id,
        before[0].id,
      ]);
    }),
  ),
);

it.live('engine sessions and connection settings are private to each instance', () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const a = yield* f.store('a');
      yield* a.load();
      const chat = history();
      yield* a.flush([chat]);
      const b = yield* f.store('b');
      const remote = yield* b.load();
      expect(remote[0].messages).toEqual(chat.messages);
      expect(remote[0].owner).toBe('');
      expect(remote[0].agentSession).toBeUndefined();
      expect(remote[0].modelSettings).toBeUndefined();
      expect(remote[0].lastUIResult).toBeUndefined();
      remote[0].agentSession = 'b-session';
      remote[0].owner = 'b-game';
      remote[0].modelSettings = { model: 'b-model', effort: 'low' };
      yield* b.flush(remote);
      const again = yield* (yield* f.store('a')).load();
      expect(again[0].agentSession).toBe('private-session');
      expect(again[0].modelSettings).toEqual(chat.modelSettings);
      expect(
        inspect(
          f.file,
          (db) => db.prepare('SELECT count(*) AS n FROM chat_instance_state').get()!.n,
        ),
      ).toBe(2);
      const count = inspect(
        f.file,
        (db) => db.prepare('SELECT revision FROM chats').get()!.revision,
      );
      expect(count).toBe(0);
      chat.messages.push({ role: 'assistant', text: 'New shared history' });
      yield* a.flush([chat]);
      const refreshed = yield* (yield* f.store('b')).load();
      expect(refreshed[0].agentSession).toBeUndefined();
      expect(refreshed[0].modelSettings).toEqual(remote[0].modelSettings);
      expect(refreshed[0].messages).toEqual(chat.messages);
      yield* a.flush([]);
      expect(
        inspect(
          f.file,
          (db) => db.prepare('SELECT count(*) AS n FROM chat_instance_state').get()!.n,
        ),
      ).toBe(0);
    }),
  ),
);

test.each([true, false, null, 'text', [1, { nested: true }]])(
  'private JSON values survive import: %j',
  (value) =>
    Effect.runPromise(
      withFixture((f) =>
        Effect.gen(function* () {
          const original = { ...history(), lastUIResult: value };
          yield* Effect.promise(() =>
            writeFile(path.join(f.root, 'chats.json'), JSON.stringify([original])),
          );
          expect((yield* (yield* f.store()).load())[0].lastUIResult).toEqual(value);
        }),
      ),
    ),
);
