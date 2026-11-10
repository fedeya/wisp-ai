import { test, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '@wisp/bridge/chat-store';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { migrateDesktop } from '@wisp/bridge/desktop-migration';

function chat(id = 'chat') {
  return { ...newChat(id, 'game'), messages: [{ role: 'user' as const, text: 'Hello' }] };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-sqlite-'));
  const file = path.join(root, 'wisp.sqlite');
  const legacy = path.join(root, 'chats.json');
  const stores: ChatStore[] = [];
  const store = () => {
    const next = new ChatStore(file, (error) => {
      throw error;
    });
    stores.push(next);
    return next;
  };
  return {
    root,
    file,
    legacy,
    store,
    async close() {
      vi.useRealTimers();
      for (const next of stores) {
        await next.close();
      }
      if (path.dirname(root) !== path.resolve(tmpdir())) {
        throw Error('Unexpected test directory');
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

test('imports complete rich history once and retains byte-for-byte legacy backups', async () => {
  const f = await fixture();
  try {
    const original = [
      {
        ...chat(),
        characterKey: '["Forever","Realm","Mage"]',
        eveId: 'session',
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
    await writeFile(f.legacy, bytes);
    const store = f.store();
    const loaded = await store.load();
    expect(loaded[0]).toMatchObject(original[0]);
    expect(await readFile(f.legacy, 'utf8')).toBe(bytes);
    const backups = (await readdir(f.root)).filter((name) => name.startsWith('chats.pre-sqlite-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(f.root, backups[0]), 'utf8')).toBe(bytes);
    expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM messages').get()!.n)).toBe(
      1,
    );
    loaded[0].title = 'Saved in SQLite';
    await store.flush(loaded);
    await store.close();
    // A stale or corrupt JSON cannot replace the successfully imported database.
    await writeFile(f.legacy, '{stale and broken');
    const reopened = f.store();
    expect((await reopened.load())[0].title).toBe('Saved in SQLite');
    await reopened.flush([]);
    await reopened.close();
    expect(await f.store().load()).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([
  '{broken',
  JSON.stringify([chat(), { ...chat('bad'), messages: [{ role: 'assistant', text: 42 }] }]),
  JSON.stringify([chat(), chat()]),
])('invalid or duplicate legacy history is preserved without partial import: %s', async (bytes) => {
  const f = await fixture();
  try {
    await writeFile(f.legacy, bytes);
    const store = f.store();
    await expect(store.load()).rejects.toThrow('preserved');
    await expect(store.flush([])).rejects.toThrow('Load conversations');
    expect(await readFile(f.legacy, 'utf8')).toBe(bytes);
    expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chats').get()!.n)).toBe(0);
    // Correcting the source permits a clean retry after the failed import.
    await writeFile(f.legacy, JSON.stringify([chat()]));
    expect(await f.store().load()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a failed migration rolls back all rows and retries with the existing backup', async () => {
  const f = await fixture();
  try {
    const initial = f.store();
    await initial.load();
    await initial.close();
    inspect(f.file, (db) =>
      db.exec(`DELETE FROM metadata;
      CREATE TRIGGER inject_failure BEFORE INSERT ON messages WHEN NEW.position = 1
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`),
    );
    const original = chat();
    original.messages.push({ role: 'user', text: 'Second message' });
    await writeFile(f.legacy, JSON.stringify([original]));
    await expect(f.store().load()).rejects.toThrow('preserved');
    expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chats').get()!.n)).toBe(0);
    expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM metadata').get()!.n)).toBe(
      0,
    );
    inspect(f.file, (db) => db.exec('DROP TRIGGER inject_failure'));
    expect((await f.store().load())[0].messages).toEqual(original.messages);
    expect(
      (await readdir(f.root)).filter((name) => name.startsWith('chats.pre-sqlite-')),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('empty drafts are neither restored nor saved; deletion cascades to messages', async () => {
  const f = await fixture();
  try {
    const draft = newChat('draft', 'game');
    await writeFile(f.legacy, JSON.stringify([draft, chat()]));
    const store = f.store();
    expect((await store.load()).map((c) => c.id)).toEqual(['chat']);
    await store.flush([draft, chat()]);
    expect(inspect(f.file, (db) => db.prepare('SELECT id FROM chats').all())).toEqual([
      { id: 'chat' },
    ]);
    await store.flush([]);
    expect(inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM messages').get()!.n)).toBe(
      0,
    );
  } finally {
    await f.close();
  }
});

test('restart interrupts active turns and queued saves capture independent snapshots', async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.legacy,
      JSON.stringify([
        {
          ...chat(),
          status: 'working',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            compactions: 0,
            compacting: true,
          },
        },
      ]),
    );
    const store = f.store();
    const chats = await store.load();
    expect(chats[0].status).toBe('interrupted');
    expect(chats[0].usage!.compacting).toBe(false);
    const first = store.flush(chats);
    chats[0].title = 'Latest';
    await Promise.all([first, store.flush(chats)]);
    await store.close();
    expect((await f.store().load())[0].title).toBe('Latest');
  } finally {
    await f.close();
  }
});

test('streaming writes update only changed messages and preserve other conversations', async () => {
  const f = await fixture();
  try {
    const store = f.store();
    await store.load();
    const chats = [chat(), chat('other')];
    await store.flush(chats);
    inspect(f.file, (db) =>
      db.exec(`CREATE TABLE changed_messages(chat_id TEXT);
      CREATE TRIGGER message_updates AFTER UPDATE ON messages
      BEGIN INSERT INTO changed_messages VALUES(NEW.chat_id); END;`),
    );
    vi.useFakeTimers();
    chats[0].messages[0].text = 'Streaming update';
    store.schedule(() => chats);
    store.schedule(() => chats);
    await vi.advanceTimersByTimeAsync(1000);
    await store.flush(chats);
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
    await store.flush(chats);
    chats[0].messages.splice(0, 1);
    await store.flush(chats);
    await store.close();
    expect((await f.store().load())[0].messages).toEqual(chats[0].messages);
  } finally {
    await f.close();
  }
});

test('stale writes fail atomically instead of overwriting another connection', async () => {
  const f = await fixture();
  try {
    const first = f.store();
    await first.load();
    await first.flush([chat(), chat('other')]);
    const stale = f.store();
    const old = await stale.load();
    const latest = [chat(), chat('other')];
    latest[0].title = 'Committed';
    await first.flush(latest);
    old[1].title = 'Must roll back';
    old[0].title = 'Stale';
    await expect(stale.flush(old.reverse())).rejects.toThrow('another process');
    const stored = await f.store().load();
    expect(stored[0].title).toBe('Committed');
    expect(stored[1].title).toBe('New conversation');
  } finally {
    await f.close();
  }
});

test.each(['incompatible schema', 'corrupt database'])(
  'refuses %s instead of silently falling back to JSON',
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === 'incompatible schema') {
        inspect(f.file, (db) =>
          db.exec(
            "CREATE TABLE chats(id TEXT PRIMARY KEY, title TEXT); INSERT INTO chats VALUES ('keep', 'original')",
          ),
        );
      } else {
        await writeFile(f.file, 'not a SQLite file');
      }
      const original = await readFile(f.file);
      await writeFile(f.legacy, JSON.stringify([chat()]));
      await expect(f.store().load()).rejects.toThrow('preserved');
      if (kind === 'incompatible schema') {
        expect(inspect(f.file, (db) => db.prepare('SELECT * FROM chats').all())).toEqual([
          { id: 'keep', title: 'original' },
        ]);
      } else {
        expect(await readFile(f.file)).toEqual(original);
      }
    } finally {
      await f.close();
    }
  },
);

test('installation import snapshots WAL data and detaches engine sessions only in the copy', async () => {
  const f = await fixture();
  const source = path.join(f.root, 'old');
  const destination = path.join(f.root, 'new');
  let sourceStore: ChatStore | undefined;
  try {
    await writeFile(path.join(f.root, 'config.local.json'), JSON.stringify({ wow: 'test' }));
    sourceStore = new ChatStore(path.join(source, 'runtime/wisp.sqlite'), () => {});
    await sourceStore.load();
    const original = { ...chat(), eveId: 'source-session', status: 'working' as const };
    await sourceStore.flush([original]);
    await writeFile(
      path.join(source, 'runtime/chats.json'),
      '{stale JSON must not override SQLite',
    );
    await writeFile(path.join(source, 'config.local.json'), JSON.stringify({ wow: 'test' }));
    // No desktop endpoint: source DB remains open with committed WAL pages.
    await migrateDesktop(source, destination, '');
    const imported = new ChatStore(path.join(destination, 'runtime/wisp.sqlite'), () => {});
    try {
      const chats = await imported.load();
      expect(chats[0].eveId).toBeUndefined();
      expect(chats[0].status).toBe('interrupted');
      expect(chats[0].messages).toEqual(original.messages);
    } finally {
      await imported.close();
    }
    expect(
      inspect(
        path.join(source, 'runtime/wisp.sqlite'),
        (db) => db.prepare('SELECT eve_id FROM chat_instance_state').get()!.eve_id,
      ),
    ).toBe('source-session');
  } finally {
    await sourceStore?.close();
    await f.close();
  }
});
