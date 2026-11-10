import { test, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ChatStore } from '@wisp/bridge/chat-store';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { preparePrivateDatabase } from '@wisp/bridge/db/private-file';

test('startup reads messages, private state and revisions from one snapshot during a concurrent commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-startup-snapshot-'));
  const file = path.join(root, 'chats.sqlite');
  const seed = new ChatStore(file, () => {});
  const reader = new ChatStore(file, () => {});
  let writer: DatabaseSync | undefined;
  const prepare = DatabaseSync.prototype.prepare;
  let intercepted: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await seed.load();
    const original = {
      ...newChat('chat', 'game'),
      title: 'Original',
      eveId: 'old-session',
      messages: [{ role: 'user' as const, text: 'Original message' }],
    };
    await seed.flush([original]);
    await seed.close();
    writer = new DatabaseSync(file, { timeout: 5000 });
    let committed = false;
    intercepted = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      query: string,
    ) {
      const statement = prepare.call(this, query);
      if (/\bfrom\s+["`]?messages["`]?\s+order/i.test(query)) {
        const all = statement.all;
        vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
          const result = Reflect.apply(all, statement, parameters);
          if (!committed) {
            committed = true;
            writer!.exec('BEGIN IMMEDIATE');
            writer!
              .prepare("UPDATE messages SET text='Concurrent message' WHERE chat_id='chat'")
              .run();
            writer!
              .prepare(
                "UPDATE chats SET title='Concurrent title', revision=revision+1 WHERE id='chat'",
              )
              .run();
            writer!
              .prepare(
                "UPDATE chat_instance_state SET eve_id='new-session', history_revision=1, revision=revision+1 WHERE chat_id='chat'",
              )
              .run();
            writer!.exec('COMMIT');
          }
          return result;
        });
      }
      return statement;
    });
    const loaded = await reader.load();
    intercepted.mockRestore();
    expect(committed).toBe(true);
    expect(loaded[0].title).toBe('Original');
    expect(loaded[0].eveId).toBe('old-session');
    expect(loaded[0].messages[0].text).toBe('Original message');
    loaded[0].messages[0].text = 'Edit based on the old snapshot';
    await expect(reader.flush(loaded)).rejects.toThrow('another process');
    expect(writer.prepare('SELECT text FROM messages').get()!.text).toBe('Concurrent message');
    expect(writer.prepare('SELECT eve_id FROM chat_instance_state').get()!.eve_id).toBe(
      'new-session',
    );
  } finally {
    intercepted?.mockRestore();
    vi.restoreAllMocks();
    writer?.close();
    await seed.close();
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preparing private file permissions never truncates an existing database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-private-open-'));
  const file = path.join(root, 'chats.sqlite');
  const seed = new ChatStore(file, () => {});
  const reader = new ChatStore(file, () => {});
  try {
    await seed.load();
    const chat = {
      ...newChat('chat', 'game'),
      messages: [{ role: 'user' as const, text: 'Preserve this' }],
    };
    await seed.flush([chat]);
    await seed.close();
    const bytes = await readFile(file);
    await preparePrivateDatabase(file);
    expect(await readFile(file)).toEqual(bytes);
    expect((await reader.load())[0].messages).toEqual(chat.messages);
    await reader.close();
  } finally {
    await seed.close();
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform !== 'win32').each(['new', 'existing'])(
  'database and WAL/SHM files stay owner-only with umask 0022: %s',
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-private-mode-'));
    try {
      const source = `
        import { chmod, stat } from 'node:fs/promises';
        import { DatabaseSync } from 'node:sqlite';
        import { ChatStore } from '@wisp/bridge/chat-store';
        import { newChat } from '@wisp/bridge/chat-lifecycle';
        process.umask(0o022);
        const file = process.argv[1];
        let existing;
        if (process.argv[2] === 'existing') {
          existing = new DatabaseSync(file);
          existing.exec('PRAGMA journal_mode=WAL; CREATE TABLE permission_probe(value TEXT);');
          for (const suffix of ['', '-wal', '-shm']) await chmod(file + suffix, 0o644);
        }
        const store = new ChatStore(file, (error) => { throw error; });
        try {
          await store.load();
          await store.flush([{ ...newChat('chat', 'game'), messages: [{role:'user',text:'Private'}] }]);
          const modes = await Promise.all(['', '-wal', '-shm'].map(async suffix => (await stat(file + suffix)).mode & 0o777));
          console.log(JSON.stringify(modes));
        } finally { await store.close(); existing?.close(); }
      `;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', source, path.join(root, 'chats.sqlite'), kind],
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
