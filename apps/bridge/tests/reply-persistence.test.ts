import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/chat-store.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { projectChats } from '../src/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';
import { ReplyProjection } from '../src/reply-stream.ts';
import { applyEvent } from '../src/events.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-reply-source-'));
  const file = path.join(root, 'wisp.sqlite'),
    legacy = path.join(root, 'chats.json');
  const stores: ChatStore[] = [];
  return {
    file,
    legacy,
    store() {
      const store = new ChatStore(file, () => {});
      stores.push(store);
      return store;
    },
    async close() {
      for (const store of stores) {
        await store.close();
      }
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('wisp-reply-source-')
      ) {
        throw Error('Unexpected temporary database directory');
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('old Markdown tables render without rewriting canonical history or the legacy JSON backup', async () => {
  const f = await fixture();
  try {
    const chat = newChat('tables', 'game');
    const text =
      'Antes.\n\n| Hueco | Lo que llevás | Qué buscar | Qué ganarías |\n|---|---|---|---|\n| Guantes | [[ref:gloves]] | Guantes de lana | +2 Intelecto |\n\nDespués.';
    chat.messages.push({
      id: 'saved-reply',
      role: 'assistant',
      text,
      streaming: false,
      references: { gloves: { kind: 'item', id: 100, label: 'Guantes' } },
      ui: [],
      parts: [{ type: 'text', text }],
    });
    const original = JSON.stringify([chat]);
    await writeFile(f.legacy, original);
    const store = f.store(),
      restored = await store.load();
    const state = createSessionState(restored);
    state.activeChat = chat.id;
    const reply = projectChats(state).chats[0].messages![0];
    expect(reply.ui?.[0].kind).toBe('table');
    expect(reply.text).toBe(text);
    expect(reply.references).toEqual(chat.messages[0].references);
    expect(reply.parts?.map((part) => part.type)).toEqual(['text', 'ui', 'text']);
    expect(restored[0].messages[0]).toEqual(chat.messages[0]);
    await store.flush(restored);
    const again = await f.store().load(),
      stateAgain = createSessionState(again);
    stateAgain.activeChat = chat.id;
    expect(projectChats(stateAgain).chats[0].messages![0]).toEqual(reply);
    expect(again[0].messages[0].ui).toEqual([]);
    expect(await readFile(f.legacy, 'utf8')).toBe(original);
  } finally {
    await f.close();
  }
});

test('table projection preserves legacy card order and ignores user, tool and partial messages', async () => {
  const f = await fixture();
  try {
    const chat = newChat('legacy', 'game');
    const text = '| Pieza | Estado |\n|---|---|\n| Toga | Equipada |\n';
    chat.messages.push(
      { role: 'user', text },
      { role: 'tool', text },
      { role: 'assistant', text, streaming: true },
      { role: 'assistant', text, ui: [{ id: 'existing', kind: 'stat', label: 'DPS', value: '1' }] },
    );
    await writeFile(f.legacy, JSON.stringify([chat]));
    const restored = await f.store().load(),
      state = createSessionState(restored);
    state.activeChat = chat.id;
    expect(restored[0].messages.slice(0, 3)).toEqual(chat.messages.slice(0, 3));
    const reply = projectChats(state).chats[0].messages![3];
    expect(reply.ui?.map((node) => node.kind)).toEqual(['stat', 'table']);
    expect(reply.parts?.filter((part) => part.type === 'ui').map((part) => part.id)).toEqual([
      reply.ui?.[1].id,
      'existing',
    ]);
  } finally {
    await f.close();
  }
});

test('SQLite preserves exact reply source on a display failure; only the view contains the error', async () => {
  const f = await fixture();
  try {
    const store = f.store();
    await store.load();
    const chat = newChat('raw', 'game'),
      raw = '{"type":"text_delta","text":"unfinished source 🧙';
    applyEvent(
      chat,
      { type: 'content.completed', data: { partId: 'answer', kind: 'text', value: raw } },
      new ReplyProjection(),
    );
    expect(chat.messages[0].rawReply).toBe(raw);
    expect(chat.messages[0].role).toBe('assistant');
    expect(chat.messages[0].text).toBe('');
    await store.flush([chat]);
    const restored = await f.store().load(),
      before = JSON.stringify(restored);
    const state = createSessionState(restored);
    state.activeChat = chat.id;
    const display = projectChats(state);
    expect(display.chats[0].messages?.[0].role).toBe('system');
    expect(display.chats[0].messages?.[0].text).toContain('could not be displayed');
    expect(JSON.stringify(display)).not.toContain('rawReply');
    expect(JSON.stringify(display)).not.toContain('unfinished source');
    expect(JSON.stringify(restored)).toBe(before);
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      const row = db.prepare('SELECT role,text,extras FROM messages').get()!;
      expect(row.role).toBe('assistant');
      expect(row.text).toBe('');
      expect(JSON.parse(String(row.extras)).rawReply).toBe(raw);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('SQLite retains source beyond display limits, including interrupted and authoritative final output', async () => {
  const f = await fixture();
  try {
    const store = f.store();
    await store.load();
    const chat = newChat('raw', 'game'),
      projection = new ReplyProjection();
    const raw = 'Texto '.repeat(5000) + 'fin 😀';
    applyEvent(
      chat,
      {
        type: 'content.delta',
        data: { partId: 'answer', kind: 'text', delta: raw.slice(0, 15000) },
      },
      projection,
    );
    expect(chat.messages[0].rawReply).toBe(raw.slice(0, 15000));
    await store.flush([chat]);
    const interrupted = await f.store().load();
    expect(interrupted[0].messages[0].rawReply).toBe(raw.slice(0, 15000));
    expect(interrupted[0].messages[0].streaming).toBe(false);
    applyEvent(
      chat,
      { type: 'content.completed', data: { partId: 'answer', kind: 'text', value: raw } },
      projection,
    );
    await store.flush([chat]);
    const restored = await f.store().load(),
      state = createSessionState(restored);
    state.activeChat = chat.id;
    expect(restored[0].messages[0].rawReply).toBe(raw);
    expect(projectChats(state).chats[0].messages?.[0].text.length).toBeLessThanOrEqual(20000);
    expect(chat.messages).toHaveLength(1);
  } finally {
    await f.close();
  }
});
