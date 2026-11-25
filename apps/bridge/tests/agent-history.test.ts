import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { uuidv7Time } from '@wisp/protocol/uuid';
import { databaseScope } from './database-fixture.ts';
import { AGENT_MESSAGE_FORMAT, AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { agentEntries, agentSessions } from '../src/db/schema.ts';
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
    entries: () => database.orm.select().from(agentEntries).orderBy(agentEntries.seq).all(),
    messages: () =>
      database.orm
        .select()
        .from(agentEntries)
        .all()
        .filter((row) => row.type === 'message'),
    compactions: () =>
      database.orm
        .select()
        .from(agentEntries)
        .all()
        .filter((row) => row.type === 'compaction'),
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
      next: 2,
      messages: [
        { seq: 0, message: { role: 'user', content: 'Question' }, model: 'gpt' },
        { seq: 1, message: { role: 'assistant', content: 'Answer' }, model: 'claude' },
      ],
    });
    // Every entry has its own UUID v7, stamped with its creation time.
    for (const row of f.entries()) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(uuidv7Time(row.id)).toBe(row.createdAt);
    }
    expect(new Set(f.entries().map((row) => row.id)).size).toBe(2);
    expect(f.entries().map((row) => [row.seq, row.role, row.model])).toEqual([
      [0, 'user', 'gpt'],
      [1, 'assistant', 'claude'],
    ]);
  } finally {
    await f.close();
  }
});

test('compaction is a log entry with a summary and where reading starts; nothing is deleted', async () => {
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
      next: 8,
      messages: turns.slice(4).map((message, index) => ({ seq: 4 + index, message, model: 'gpt' })),
    });
    // The next turn logs after the compactions; reading skips them.
    await f.history.append('s', 8, [{ role: 'user', content: 'Next' }], 'gpt');
    await f.history.compact('s', { keptFrom: 8, summary: 'Latest summary', model: 'claude' });
    const loaded = await f.history.load('s');
    expect(loaded.summary).toBe('Latest summary');
    expect(loaded.messages.map((entry) => entry.seq)).toEqual([8]);
    expect(f.entries().map((row) => [row.seq, row.type, row.role])).toEqual([
      ...turns.map((turn, index) => [index, 'message', turn.role]),
      [6, 'compaction', null],
      [7, 'compaction', null],
      [8, 'message', 'user'],
      [9, 'compaction', null],
    ]);
    expect(JSON.parse(f.compactions().at(-1)!.data)).toEqual({
      keptFrom: 8,
      summary: 'Latest summary',
    });
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
