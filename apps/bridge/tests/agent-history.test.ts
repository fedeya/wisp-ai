import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { databaseScope } from './database-fixture.ts';
import { AGENT_MESSAGE_FORMAT, AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { agentCompactions, agentMessages, agentSessions } from '../src/db/schema.ts';
import type { ApplicationDatabase } from '../src/db/application-database.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-agent-history-'));
  const scope = databaseScope();
  const file = path.join(directory, 'wisp.sqlite');
  let clock = 1000;
  const database = scope.open(file) as ApplicationDatabase;
  const history = new AgentHistory(database, { wispVersion: '9.9.9', now: () => clock });
  return {
    file,
    scope,
    history,
    tick: (ms: number) => void (clock += ms),
    session: (id: string) =>
      database.orm.select().from(agentSessions).where(eq(agentSessions.id, id)).get(),
    messages: () => database.orm.select().from(agentMessages).all(),
    compactions: () => database.orm.select().from(agentCompactions).all(),
    async close() {
      await scope.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('agent history appends turns with their model and replaces a retried turn', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    await f.history.append('s', 0, [{ role: 'user', content: 'Question' }], 'gpt');
    await f.history.append(
      's',
      1,
      [
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
      ],
      'gpt',
    );
    // A retried turn overwrites what followed its start.
    await f.history.append('s', 1, [{ role: 'assistant', content: 'Answer' }], 'claude');
    expect(await new AgentHistory(f.scope.open(f.file)).load('s')).toEqual({
      summary: undefined,
      start: 0,
      messages: [
        { message: { role: 'user', content: 'Question' }, model: 'gpt' },
        { message: { role: 'assistant', content: 'Answer' }, model: 'claude' },
      ],
    });
    expect(f.messages().map((row) => [row.position, row.role, row.model])).toEqual([
      [0, 'user', 'gpt'],
      [1, 'assistant', 'claude'],
    ]);
  } finally {
    await f.close();
  }
});

test('compaction records a summary and where reading starts, and deletes nothing', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    const turns = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: 'Message ' + index,
    }));
    await f.history.append('s', 0, turns, 'gpt');
    await f.history.compact('s', { keptFrom: 2, summary: 'First summary', model: 'gpt' });
    await f.history.compact('s', { keptFrom: 4, model: 'gpt' });
    // The latest compaction wins; one without a summary just starts reading later.
    expect(await f.history.load('s')).toEqual({
      summary: undefined,
      start: 4,
      messages: turns.slice(4).map((message) => ({ message, model: 'gpt' })),
    });
    await f.history.compact('s', { keptFrom: 4, summary: 'Retried summary', model: 'gpt' });
    expect((await f.history.load('s')).summary).toBe('Retried summary');
    // A turn after compaction appends after every stored message.
    await f.history.append('s', 6, [{ role: 'user', content: 'Next' }], 'gpt');
    expect(f.messages()).toHaveLength(7);
    expect(f.compactions()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('a session records its chat, latest model, format, version and token totals', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'connection:abc:claude' });
    f.tick(2000);
    // The chat keeps its session when its model changes; the session records the latest one.
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    await f.history.addUsage('s', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 });
    await f.history.addUsage('s', {
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 7,
      cacheWriteTokens: 30,
    });
    expect(f.session('s')).toMatchObject({
      chatId: 'chat',
      model: 'gpt',
      format: AGENT_MESSAGE_FORMAT,
      wispVersion: '9.9.9',
      createdAt: 1000,
      updatedAt: 3000,
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
      await f.history.append(session, 0, [{ role: 'user', content: session }], 'm');
      await f.history.compact(session, { keptFrom: 0, summary: 'S', model: 'm' });
    }
    await f.history.delete('ended');
    expect((await f.history.load('ended')).messages).toEqual([]);
    expect(f.messages()).toHaveLength(3);
    expect(f.compactions()).toHaveLength(3);

    const chats = new ChatStore(f.scope.open(f.file), () => {});
    await chats.load();
    const gone = { ...newChat('gone', 'game'), agentSession: 'deleted', title: 'Gone' };
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }, gone]);
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }]);
    await chats.close();
    expect(f.session('deleted')).toBeUndefined();

    await f.history.prune();
    expect((await f.history.load('kept')).messages).toHaveLength(1);
    expect(f.session('orphan')).toBeUndefined();
    expect(f.messages()).toHaveLength(1);
    expect(f.compactions()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
