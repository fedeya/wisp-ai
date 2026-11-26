import { test, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatsAt, testDirectory, TestDirectory } from './storage-fixture.ts';
import { preparePrivateDatabase } from '@wisp/db/private-file';

it.live(
  'startup reads messages, private state and revisions while writers wait, then detects their commit',
  () =>
    Effect.gen(function* () {
      const { file } = yield* TestDirectory;
      const seed = yield* chatsAt(file);
      let writer: DatabaseSync | undefined;
      const prepare = DatabaseSync.prototype.prepare;
      let intercepted: ReturnType<typeof vi.spyOn> | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          intercepted?.mockRestore();
          vi.restoreAllMocks();
          writer?.close();
        }),
      );
      yield* seed.load();
      const original = {
        ...newChat('chat', 'game'),
        title: 'Original',
        agentSession: 'old-session',
        messages: [{ role: 'user' as const, text: 'Original message' }],
      };
      yield* seed.flush([original]);
      yield* seed.close();
      const reader = yield* chatsAt(file);
      // No busy wait: a writer that cannot take the lock fails at once instead of
      // blocking the thread the reader runs on.
      writer = new DatabaseSync(file, { timeout: 0 });
      let blocked = false;
      let attempted = false;
      intercepted = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
        this: DatabaseSync,
        query: string,
      ) {
        const statement = prepare.call(this, query);
        if (/\bfrom\s+["`]?messages["`]?\s+order/i.test(query)) {
          const all = statement.all;
          vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
            const result = Reflect.apply(all, statement, parameters);
            if (!attempted) {
              attempted = true;
              try {
                writer!.exec('BEGIN IMMEDIATE');
                writer!.exec('ROLLBACK');
              } catch {
                blocked = true;
              }
            }
            return result;
          });
        }
        return statement;
      });
      const loaded = yield* reader.load();
      intercepted.mockRestore();
      expect([attempted, blocked]).toEqual([true, true]);
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("UPDATE messages SET text='Concurrent message' WHERE chat_id='chat'").run();
      writer
        .prepare("UPDATE chats SET title='Concurrent title', revision=revision+1 WHERE id='chat'")
        .run();
      writer
        .prepare(
          "UPDATE chat_instance_state SET agent_session='new-session', history_revision=1, revision=revision+1 WHERE chat_id='chat'",
        )
        .run();
      writer.exec('COMMIT');
      expect(loaded[0].title).toBe('Original');
      expect(loaded[0].agentSession).toBe('old-session');
      expect(loaded[0].messages[0].text).toBe('Original message');
      loaded[0].messages[0].text = 'Edit based on the old snapshot';
      expect((yield* Effect.flip(reader.flush(loaded))).message).toContain('another process');
      expect(writer.prepare('SELECT text FROM messages').get()!.text).toBe('Concurrent message');
      expect(
        writer.prepare('SELECT agent_session FROM chat_instance_state').get()!.agent_session,
      ).toBe('new-session');
    }).pipe(Effect.scoped, Effect.provide(testDirectory)),
);

it.live('preparing private file permissions never truncates an existing database', () =>
  Effect.gen(function* () {
    const { file } = yield* TestDirectory;
    const seed = yield* chatsAt(file);
    yield* seed.load();
    const chat = {
      ...newChat('chat', 'game'),
      messages: [{ role: 'user' as const, text: 'Preserve this' }],
    };
    yield* seed.flush([chat]);
    yield* seed.close();
    const bytes = yield* Effect.promise(async () => readFile(file));
    yield* Effect.promise(async () => preparePrivateDatabase(file));
    expect(yield* Effect.promise(async () => readFile(file))).toEqual(bytes);
    const reader = yield* chatsAt(file);
    expect((yield* reader.load())[0].messages).toEqual(chat.messages);
  }).pipe(Effect.scoped, Effect.provide(testDirectory)),
);

test.runIf(process.platform !== 'win32').each(['new', 'existing'])(
  'database and WAL/SHM files stay owner-only with umask 0022: %s',
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-private-mode-'));
    try {
      const source = `
        import { chmod, stat } from 'node:fs/promises';
        import { DatabaseSync } from 'node:sqlite';
        import { Effect, Layer } from 'effect';
        import * as Sql from '@wisp/db/sql-database';
        import * as Chats from '@wisp/server/chat-store';
        import { newChat } from '@wisp/server/chat-lifecycle';
        process.umask(0o022);
        const file = process.argv[1];
        let existing;
        if (process.argv[2] === 'existing') {
          existing = new DatabaseSync(file);
          existing.exec('PRAGMA journal_mode=WAL; CREATE TABLE permission_probe(value TEXT);');
          for (const suffix of ['', '-wal', '-shm']) await chmod(file + suffix, 0o644);
        }
        try {
          const storage = Chats.layer({ onError: (error) => { throw error; } })
            .pipe(Layer.provideMerge(Sql.layer(file)));
          await Effect.runPromise(Effect.gen(function* () {
            const store = yield* Chats.ChatStore;
            yield* store.load();
            yield* store.flush([{ ...newChat('chat', 'game'), messages: [{role:'user',text:'Private'}] }]);
          }).pipe(Effect.provide(storage)));
          const modes = await Promise.all(['', '-wal', '-shm'].map(async suffix => (await stat(file + suffix)).mode & 0o777));
          console.log(JSON.stringify(modes));
        } finally { existing?.close(); }
      `;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', source, path.join(root, 'wisp.sqlite'), kind],
        {
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          windowsHide: true,
        },
      );
      expect(JSON.parse(stdout)).toEqual([0o600, 0o600, 0o600]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
