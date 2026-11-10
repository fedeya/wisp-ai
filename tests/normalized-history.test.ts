import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '@wisp/bridge/chat-store';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { migrateChats, migrationsFolder } from '@wisp/bridge/db/migrate';
import type { Chat } from '@wisp/bridge/chat';

const initial = '20261109234044_initial-chat-schema';
const normalized = '20261110001924_normalize-conversations';
function history(): Chat {
  return {
    ...newChat('rich', 'old-game'),
    title: 'Preserve 🧙 世界',
    characterKey: 'character',
    eveId: 'private-session',
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
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-normalized-'));
  const file = path.join(root, 'chats.sqlite');
  const stores: ChatStore[] = [];
  return {
    root,
    file,
    store(instanceId?: string) {
      const store = new ChatStore(file, () => {}, undefined, { instanceId });
      stores.push(store);
      return store;
    },
    async close() {
      for (const store of stores) {
        await store.close();
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
async function oldDatabase(file: string, version: number, chat: Chat) {
  const sql = await readFile(path.join(migrationsFolder, initial, 'migration.sql'), 'utf8');
  const db = new DatabaseSync(file);
  db.exec(sql);
  const { messages, ...metadata } = chat;
  db.prepare('INSERT INTO chats VALUES(?,?,?,?,?,?)').run(
    chat.id,
    0,
    chat.characterKey ?? null,
    chat.lastActivityAt ?? 0,
    9,
    JSON.stringify(metadata),
  );
  messages.forEach((message, index) =>
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run(chat.id, index, JSON.stringify(message)),
  );
  db.exec("INSERT INTO metadata VALUES('initialized','1')");
  if (version === 2) {
    db.exec(
      'CREATE TABLE wisp_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT',
    );
    db.prepare('INSERT INTO wisp_migrations VALUES(?,?,?)').run(
      initial,
      createHash('sha256').update(sql).digest('hex'),
      0,
    );
  }
  db.exec(`PRAGMA user_version=${version}`);
  return db;
}

test.each([1, 2])(
  'SQLite v%i normalization preserves rich history and assigns stable storage IDs',
  async (version) => {
    const f = await fixture();
    const original = {
      ...history(),
      futureMetadata: { keep: true },
      messages: history().messages.map((m) => ({ ...m, futureField: ['keep', 1] })),
    };
    const old = await oldDatabase(f.file, version, original);
    old.close();
    try {
      const store = f.store();
      const loaded = await store.load();
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
      await store.flush(loaded);
      await store.close();
      expect((await f.store().load())[0]).toMatchObject(original);
      expect(
        inspect(f.file, (db) => db.prepare('SELECT id FROM messages ORDER BY position').all()),
      ).toEqual(ids);
    } finally {
      await f.close();
    }
  },
);

test('message identities survive edits, insertion, reordering, deletion and reopening', async () => {
  const f = await fixture();
  try {
    const store = f.store();
    await store.load();
    const chat = history();
    await store.flush([chat]);
    const rows = () =>
      inspect(f.file, (db) => db.prepare('SELECT id,text FROM messages ORDER BY position').all());
    const before = rows();
    chat.messages[0].text = 'Edited';
    chat.messages.reverse();
    chat.messages.splice(1, 0, { role: 'user', text: 'Inserted' });
    await store.flush([chat]);
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
    await store.flush([chat]);
    expect(rows().map((r) => r.id)).toEqual(stable);
    chat.messages.splice(1, 1);
    await store.flush([chat]);
    await store.close();
    expect((await f.store().load())[0].messages).toEqual(chat.messages);
    expect(rows().map((r) => r.id)).toEqual([
      before[3].id,
      before[2].id,
      before[1].id,
      before[0].id,
    ]);
  } finally {
    await f.close();
  }
});

test('engine sessions and connection settings are private to each instance', async () => {
  const f = await fixture();
  try {
    const a = f.store('a');
    await a.load();
    const chat = history();
    await a.flush([chat]);
    const b = f.store('b');
    const remote = await b.load();
    expect(remote[0].messages).toEqual(chat.messages);
    expect(remote[0].owner).toBe('');
    expect(remote[0].eveId).toBeUndefined();
    expect(remote[0].modelSettings).toBeUndefined();
    expect(remote[0].lastUIResult).toBeUndefined();
    remote[0].eveId = 'b-session';
    remote[0].owner = 'b-game';
    remote[0].modelSettings = { model: 'b-model', effort: 'low' };
    await b.flush(remote);
    const again = await f.store('a').load();
    expect(again[0].eveId).toBe('private-session');
    expect(again[0].modelSettings).toEqual(chat.modelSettings);
    expect(
      inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chat_instance_state').get()!.n),
    ).toBe(2);
    const count = inspect(f.file, (db) => db.prepare('SELECT revision FROM chats').get()!.revision);
    expect(count).toBe(0);
    chat.messages.push({ role: 'assistant', text: 'New shared history' });
    await a.flush([chat]);
    const refreshed = await f.store('b').load();
    expect(refreshed[0].eveId).toBeUndefined();
    expect(refreshed[0].modelSettings).toEqual(remote[0].modelSettings);
    expect(refreshed[0].messages).toEqual(chat.messages);
    await a.flush([]);
    expect(
      inspect(f.file, (db) => db.prepare('SELECT count(*) AS n FROM chat_instance_state').get()!.n),
    ).toBe(0);
  } finally {
    await f.close();
  }
});

test('a failed normalization rolls back table replacements and retries without losing rows', async () => {
  const f = await fixture();
  const original = history();
  const db = await oldDatabase(f.file, 2, original);
  try {
    const folder = path.join(f.root, 'migrations');
    await cp(migrationsFolder, folder, { recursive: true });
    const target = path.join(folder, normalized, 'migration.sql');
    const sql = await readFile(target, 'utf8');
    await writeFile(
      target,
      sql.replace('CREATE INDEX chats_character_activity', 'INVALID INDEX SYNTAX'),
    );
    expect(() => migrateChats(db, folder)).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(
      original.messages.length,
    );
    expect(JSON.parse(String(db.prepare('SELECT metadata FROM chats').get()!.metadata)).eveId).toBe(
      original.eveId,
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'").all()).toEqual(
      [],
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='chat_instance_state'").get(),
    ).toBeUndefined();
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    migrateChats(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
    await f.close();
  }
});

test.each([true, false, null, 'text', [1, { nested: true }]])(
  'legacy private JSON values survive normalization: %j',
  async (value) => {
    const f = await fixture();
    const original = { ...history(), lastUIResult: value };
    const db = await oldDatabase(f.file, 2, original);
    db.close();
    try {
      expect((await f.store().load())[0].lastUIResult).toEqual(value);
    } finally {
      await f.close();
    }
  },
);

test('invalid legacy rows abort normalization instead of coercing their content', async () => {
  const f = await fixture();
  const db = await oldDatabase(f.file, 2, history());
  try {
    db.prepare('UPDATE messages SET content=? WHERE position=0').run(
      JSON.stringify({ role: 'user', text: 42 }),
    );
    expect(() => migrateChats(db)).toThrow();
    expect(
      JSON.parse(String(db.prepare('SELECT content FROM messages WHERE position=0').get()!.content))
        .text,
    ).toBe(42);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
  } finally {
    db.close();
    await f.close();
  }
});
