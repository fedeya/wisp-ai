import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { databaseScope } from './database-fixture.ts';
import { AGENT_MESSAGE_FORMAT, AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { agentMessages, agentSessions } from '../src/db/schema.ts';
import type { ApplicationDatabase } from '../src/db/application-database.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-agent-history-'));
  const scope = databaseScope();
  const file = path.join(directory, 'wisp.sqlite');
  let clock = 1000;
  const database = scope.open(file);
  const history = new AgentHistory(database, { wispVersion: '9.9.9', now: () => clock });
  return {
    file,
    scope,
    database,
    history,
    tick: (ms: number) => void (clock += ms),
    session: (id: string) =>
      (database as ApplicationDatabase).orm
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .get(),
    messageCount: () =>
      (database as ApplicationDatabase).orm.select().from(agentMessages).all().length,
    async close() {
      await scope.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('agent history appends turns and replaces compacted history', async () => {
  const f = await fixture();
  try {
    await f.history.begin('kept', { chatId: 'chat', model: 'gpt-test' });
    await f.history.append('kept', 0, [{ role: 'user', content: 'Question' }]);
    await f.history.append('kept', 1, [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c',
            toolName: 't',
            output: { type: 'json', value: 1 },
          },
        ],
      },
    ]);
    // A retried turn overwrites what followed its start.
    await f.history.append('kept', 1, [{ role: 'assistant', content: 'Answer' }]);
    expect(await f.history.load('kept')).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]);
    f.tick(500);
    await f.history.replace('kept', [{ role: 'user', content: 'Summary' }]);
    expect(await new AgentHistory(f.scope.open(f.file)).load('kept')).toEqual([
      { role: 'user', content: 'Summary' },
    ]);
    expect(f.session('kept')?.compactedAt).toBe(1500);
  } finally {
    await f.close();
  }
});

test('a session records its chat, model, format, version and token totals', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'connection:abc:claude' });
    f.tick(2000);
    // A resumed turn keeps the session's model and only marks it as used.
    await f.history.begin('s', { chatId: 'chat', model: 'other' });
    await f.history.addUsage('s', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 });
    await f.history.addUsage('s', {
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 7,
      cacheWriteTokens: 30,
    });
    expect(f.session('s')).toMatchObject({
      chatId: 'chat',
      model: 'connection:abc:claude',
      format: AGENT_MESSAGE_FORMAT,
      wispVersion: '9.9.9',
      createdAt: 1000,
      updatedAt: 3000,
      compactedAt: null,
      tokensInput: 150,
      tokensOutput: 30,
      tokensReasoning: 7,
      tokensCacheRead: 60,
      tokensCacheWrite: 30,
    });
  } finally {
    await f.close();
  }
});

test('ending a session or deleting its chat removes its history; prune drops the unreferenced', async () => {
  const f = await fixture();
  try {
    for (const [session, chatId] of [
      ['kept', 'chat'],
      ['ended', 'chat'],
      ['deleted', 'gone'],
      ['orphan', 'never-saved'],
    ]) {
      await f.history.begin(session, { chatId, model: 'm' });
      await f.history.append(session, 0, [{ role: 'user', content: session }]);
    }
    await f.history.delete('ended');
    expect(await f.history.load('ended')).toEqual([]);
    expect(f.messageCount()).toBe(3);

    const chats = new ChatStore(f.scope.open(f.file), () => {});
    await chats.load();
    const gone = { ...newChat('gone', 'game'), agentSession: 'deleted', title: 'Gone' };
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }, gone]);
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }]);
    await chats.close();
    expect(f.session('deleted')).toBeUndefined();
    expect(await f.history.load('deleted')).toEqual([]);

    await f.history.prune();
    expect(await f.history.load('kept')).toHaveLength(1);
    expect(f.session('orphan')).toBeUndefined();
    expect(f.messageCount()).toBe(1);
  } finally {
    await f.close();
  }
});
