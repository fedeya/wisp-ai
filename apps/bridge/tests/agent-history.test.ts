import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Entry } from '@wisp/agent/engine';
import { uuidv7Time } from '@wisp/protocol/uuid';
import { databaseScope } from './database-fixture.ts';
import { AGENT_MESSAGE_FORMAT, AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { agentEntries, agentSessions } from '../src/db/schema.ts';
import type { ApplicationDatabase } from '../src/db/application-database.ts';

const user = (text: string): Entry => ({ type: 'user', content: [{ type: 'text', text }] });
const answer = (text: string): Entry => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { created: 0 },
});
const compaction = (keptFrom: number, summary?: string): Entry =>
  summary === undefined
    ? { type: 'compaction', keptFrom }
    : { type: 'compaction', keptFrom, summary };

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
    database,
    history,
    tick: (ms: number) => void (clock += ms),
    session: (id: string) =>
      database.orm.select().from(agentSessions).where(eq(agentSessions.id, id)).get(),
    entries: () => database.orm.select().from(agentEntries).orderBy(agentEntries.seq).all(),
    count: (type: 'messages' | 'compactions') =>
      database.orm
        .select()
        .from(agentEntries)
        .all()
        .filter((row) => (row.type === 'compaction') === (type === 'compactions')).length,
    async close() {
      await scope.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('agent history appends entries as JSON with their model and never replaces one', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    const step: Entry = {
      type: 'assistant',
      content: [
        {
          type: 'tool',
          id: 'c',
          name: 't',
          state: { status: 'completed', input: {}, output: { type: 'json', value: 1 } },
        },
      ],
      finish: 'tool-calls',
      time: { created: 1, completed: 2 },
    };
    await f.history.append(
      's',
      [{ type: 'synthetic', kind: 'memory', text: 'Mage' }, user('Q')],
      'gpt',
    );
    await f.history.append('s', [step], 'gpt');
    await f.history.append('s', [answer('Answer')], 'claude');
    const loaded = await new AgentHistory(f.scope.open(f.file)).load('s');
    expect(loaded).toEqual({
      rows: [
        { seq: 0, model: 'gpt', data: { type: 'synthetic', kind: 'memory', text: 'Mage' } },
        { seq: 1, model: 'gpt', data: user('Q') },
        { seq: 2, model: 'gpt', data: step },
        { seq: 3, model: 'claude', data: answer('Answer') },
      ],
    });
    expect(f.entries().map((row) => row.type)).toEqual([
      'synthetic',
      'user',
      'assistant',
      'assistant',
    ]);
    // Every entry has its own UUID v7, stamped with its creation time.
    for (const row of f.entries()) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(uuidv7Time(row.id)).toBe(row.createdAt);
    }
    expect(new Set(f.entries().map((row) => row.id)).size).toBe(4);
  } finally {
    await f.close();
  }
});

test('the table rejects an entry whose type does not match its data', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    const insert = () =>
      f.database.orm
        .insert(agentEntries)
        .values({
          sessionId: 's',
          seq: 0,
          id: 'x',
          type: 'user',
          model: 'gpt',
          createdAt: 0,
          data: JSON.stringify(answer('A')),
        })
        .run();
    expect(insert).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringMatching(/CHECK constraint failed: agent_entry_data_type/),
        }),
      }),
    );
  } finally {
    await f.close();
  }
});

test('compaction is a log entry with a summary and where reading starts; nothing is deleted', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    const turns = Array.from({ length: 6 }, (_, index) =>
      index % 2 ? answer('Message ' + index) : user('Message ' + index),
    );
    await f.history.append('s', turns, 'gpt');
    await f.history.append('s', [compaction(2, 'First summary')], 'gpt');
    await f.history.append('s', [compaction(4)], 'gpt');
    // The latest compaction wins; one without a summary just starts reading later.
    expect(await f.history.load('s')).toEqual({
      rows: turns.slice(4).map((data, index) => ({ seq: 4 + index, model: 'gpt', data })),
    });
    // The next turn logs after the compactions; reading skips them.
    await f.history.append('s', [user('Next')], 'gpt');
    await f.history.append('s', [compaction(8, 'Latest summary')], 'claude');
    const loaded = await f.history.load('s');
    expect(loaded.summary).toBe('Latest summary');
    expect(loaded.rows.map((row) => row.seq)).toEqual([8]);
    expect(f.entries().map((row) => [row.seq, row.type])).toEqual([
      ...turns.map((turn, index) => [index, turn.type]),
      [6, 'compaction'],
      [7, 'compaction'],
      [8, 'user'],
      [9, 'compaction'],
    ]);
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
    expect(AGENT_MESSAGE_FORMAT).toBe('wisp-1');
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
      await f.history.append(session, [user(session), compaction(0, 'S')], 'm');
    }
    await f.history.delete('ended');
    expect((await f.history.load('ended')).rows).toEqual([]);
    expect(f.count('messages')).toBe(3);
    expect(f.count('compactions')).toBe(3);

    const chats = new ChatStore(f.scope.open(f.file), () => {});
    await chats.load();
    const gone = { ...newChat('gone', 'game'), agentSession: 'deleted', title: 'Gone' };
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }, gone]);
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }]);
    await chats.close();
    expect(f.session('deleted')).toBeUndefined();

    await f.history.prune();
    expect((await f.history.load('kept')).rows).toHaveLength(1);
    expect(f.session('orphan')).toBeUndefined();
    expect(f.count('messages')).toBe(1);
    expect(f.count('compactions')).toBe(1);
  } finally {
    await f.close();
  }
});

test('a compaction logged during a turn keeps its place when the turn ends', async () => {
  const f = await fixture();
  try {
    await f.history.begin('s', { chatId: 'chat', model: 'gpt' });
    await f.history.append('s', [user('Question')], 'gpt');
    await f.history.append('s', [compaction(0, 'Summary')], 'gpt');
    await f.history.append('s', [answer('Answer')], 'gpt');
    expect(f.entries().map((row) => [row.seq, row.type])).toEqual([
      [0, 'user'],
      [1, 'compaction'],
      [2, 'assistant'],
    ]);
    const loaded = await f.history.load('s');
    expect(loaded.summary).toBe('Summary');
    expect(loaded.rows.map((row) => row.seq)).toEqual([0, 2]);
  } finally {
    await f.close();
  }
});
