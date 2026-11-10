import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceChats } from '@wisp/bridge/workspace-chats';
import { ApplicationDatabase } from '@wisp/bridge/db/application-database';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import type { Chat } from '@wisp/bridge/chat';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-workspace-chats-'));
  const databases: ApplicationDatabase[] = [];
  const open = async (instance: string) => {
    const database = new ApplicationDatabase(path.join(root, 'wisp.sqlite'));
    databases.push(database);
    const store = new WorkspaceChats(database, instance, (error) => {
      throw error;
    });
    return { database, store, chats: await store.load() };
  };
  return {
    open,
    close: async () => {
      for (const database of databases) {
        await database.close();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
const conversation = (): Chat => ({
  ...newChat('chat', 'game-a'),
  status: 'done',
  eveId: 'engine-a',
  messages: [{ role: 'user', text: 'Hello' }],
  modelSettings: { model: 'local-model', effort: 'high' },
});

test('completed history updates in both directions without sharing sessions or losing local changes', async () => {
  const f = await fixture();
  try {
    const a = await f.open('a'),
      b = await f.open('b');
    a.chats.push(conversation());
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    expect(b.chats[0]).toMatchObject({ id: 'chat', owner: '', messages: a.chats[0].messages });
    expect(b.chats[0].eveId).toBeUndefined();
    expect(b.chats[0].modelSettings).toBeUndefined();
    b.chats[0].messages.push({ role: 'assistant', text: 'From B' });
    await b.store.flush(b.chats);
    const original = a.chats[0];
    a.store.synchronize(a.chats);
    expect(a.chats[0]).toBe(original);
    expect(a.chats[0].messages.at(-1)?.text).toBe('From B');
    expect(a.chats[0].eveId).toBeUndefined();
    expect(a.chats[0].modelSettings?.model).toBe('local-model');
    a.chats[0].messages.push({ role: 'assistant', text: 'From A' });
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    expect(b.chats[0].messages.at(-1)?.text).toBe('From A');
  } finally {
    await f.close();
  }
});

test('active drafts survive restart privately and concurrent completions preserve both transcripts', async () => {
  const f = await fixture();
  try {
    const a = await f.open('a'),
      b = await f.open('b');
    a.chats.push(conversation());
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    for (const [instance, label] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      instance.chats[0].status = 'working';
      instance.chats[0].messages.push({
        role: 'assistant',
        text: label,
        rawReply: label,
        streaming: true,
      });
      await instance.store.flush(instance.chats);
    }
    const observer = await f.open('observer');
    expect(observer.chats[0].messages).toHaveLength(1);
    const recovered = await f.open('a');
    expect(recovered.chats[0].status).toBe('interrupted');
    expect(recovered.chats[0].messages.at(-1)?.text).toBe('A');
    expect(recovered.chats[0].messages.at(-1)?.rawReply).toBe('A');
    expect(recovered.chats[0].messages.at(-1)?.streaming).toBe(false);
    // The launcher prevents two simultaneous processes with identity 'a'.
    await recovered.store.close();
    a.chats[0].status = 'done';
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    expect(b.chats[0].status).toBe('working');
    b.chats[0].status = 'done';
    const runningReference = b.chats[0];
    await b.store.flush(b.chats);
    expect(b.chats).toHaveLength(2);
    expect(b.chats).toContain(runningReference);
    expect(runningReference.id).not.toBe('chat');
    expect(runningReference.title).toContain('conflict copy');
    expect(new Set(b.chats.map((c) => c.messages.at(-1)?.text))).toEqual(new Set(['A', 'B']));
    a.store.synchronize(a.chats);
    expect(a.chats).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('deletion propagates without resurrection and a racing active edit is retained as a copy', async () => {
  const f = await fixture();
  try {
    const a = await f.open('a'),
      b = await f.open('b');
    a.chats.push(conversation());
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    b.chats[0].status = 'working';
    b.chats[0].messages.push({ role: 'user', text: 'Keep this' });
    await b.store.flush(b.chats);
    a.chats.splice(0);
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    b.chats[0].status = 'done';
    await b.store.flush(b.chats);
    expect(b.chats).toHaveLength(1);
    expect(b.chats[0].id).not.toBe('chat');
    a.store.synchronize(a.chats);
    a.chats.splice(0);
    await a.store.flush(a.chats);
    b.store.synchronize(b.chats);
    expect(b.chats).toEqual([]);
    await b.store.flush(b.chats);
    expect((await f.open('c')).chats).toEqual([]);
  } finally {
    await f.close();
  }
});

test('failed publication rolls back both shared history and private drafts', async () => {
  const f = await fixture();
  try {
    const a = await f.open('a');
    a.chats.push({ ...conversation(), status: 'working' });
    await a.store.flush(a.chats);
    a.database.connection.exec(
      "CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    a.chats[0].status = 'done';
    await expect(a.store.flush(a.chats)).rejects.toThrow();
    expect((await f.open('b')).chats).toEqual([]);
    expect((await f.open('a')).chats[0].status).toBe('interrupted');
    a.database.connection.exec('DROP TRIGGER fail_message');
    await a.store.flush(a.chats);
    expect((await f.open('c')).chats[0].messages[0].text).toBe('Hello');
  } finally {
    await f.close();
  }
});
