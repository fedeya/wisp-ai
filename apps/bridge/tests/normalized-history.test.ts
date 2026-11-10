import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/chat-store.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import type { Chat } from '../src/chat.ts';

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
  const file = path.join(root, 'wisp.sqlite');
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
test('JSON import preserves rich history and assigns stable storage IDs', async () => {
  const f = await fixture();
  const original = {
    ...history(),
    futureMetadata: { keep: true },
    messages: history().messages.map((m) => ({ ...m, futureField: ['keep', 1] })),
  };
  await writeFile(path.join(f.root, 'chats.json'), JSON.stringify([original]));
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
});

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

test.each([true, false, null, 'text', [1, { nested: true }]])(
  'private JSON values survive import: %j',
  async (value) => {
    const f = await fixture();
    const original = { ...history(), lastUIResult: value };
    await writeFile(path.join(f.root, 'chats.json'), JSON.stringify([original]));
    try {
      expect((await f.store().load())[0].lastUIResult).toEqual(value);
    } finally {
      await f.close();
    }
  },
);
