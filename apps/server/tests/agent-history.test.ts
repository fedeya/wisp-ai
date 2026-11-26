import { expect } from 'vitest';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { eq } from 'drizzle-orm';
import type { Entry } from '@wisp/agent/session-message';
import { version } from 'uuid';
import { reopen, testStorage, TestDirectory } from './storage-fixture.ts';
import { AGENT_MESSAGE_FORMAT, AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { agentEntries, agentSessions } from '@wisp/db/schema';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

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

/**
 * Runs `work` with the agent history over a fresh database whose clock the
 * test moves, and a second, synchronous connection for inspecting its rows.
 */
const withHistory = <A, E, R>(
  work: (f: {
    history: AgentHistory['Service'];
    database: { orm: ReturnType<typeof drizzle> };
    tick: (ms: number) => void;
    session: (id: string) => typeof agentSessions.$inferSelect | undefined;
    entries: () => (typeof agentEntries.$inferSelect)[];
    count: (type: 'messages' | 'compactions') => number;
  }) => Effect.Effect<A, E, R>,
) => {
  let clock = 1000;
  return Effect.gen(function* () {
    const { file } = yield* TestDirectory;
    const history = yield* AgentHistory;
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (client) => Effect.sync(() => client.close()),
    );
    const orm = drizzle({ client });
    return yield* work({
      history,
      database: { orm },
      tick: (ms) => void (clock += ms),
      session: (id) => orm.select().from(agentSessions).where(eq(agentSessions.id, id)).get(),
      entries: () => orm.select().from(agentEntries).orderBy(agentEntries.seq).all(),
      count: (type) =>
        orm
          .select()
          .from(agentEntries)
          .all()
          .filter((row) => (row.type === 'compaction') === (type === 'compactions')).length,
    });
  }).pipe(Effect.scoped, Effect.provide(testStorage({ now: () => clock })));
};

it.live('agent history appends entries as JSON with their model and never replaces one', () =>
  withHistory((f) =>
    Effect.gen(function* () {
      yield* f.history.begin('s', { chatId: 'chat', model: 'gpt' });
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
      yield* f.history.append(
        's',
        [{ type: 'synthetic', kind: 'memory', text: 'Mage' }, user('Q')],
        'gpt',
      );
      yield* f.history.append('s', [step], 'gpt');
      yield* f.history.append('s', [answer('Answer')], 'claude');
      const loaded = yield* reopen(
        Effect.gen(function* () {
          return yield* (yield* AgentHistory).load('s');
        }),
      );
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
        expect(version(row.id)).toBe(7);
        expect(Number.parseInt(row.id.replaceAll('-', '').slice(0, 12), 16)).toBe(row.createdAt);
      }
      expect(new Set(f.entries().map((row) => row.id)).size).toBe(4);
    }),
  ),
);

it.live('the table rejects an entry whose type does not match its data', () =>
  withHistory((f) =>
    Effect.gen(function* () {
      yield* f.history.begin('s', { chatId: 'chat', model: 'gpt' });
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
    }),
  ),
);

it.live(
  'compaction is a log entry with a summary and where reading starts; nothing is deleted',
  () =>
    withHistory((f) =>
      Effect.gen(function* () {
        yield* f.history.begin('s', { chatId: 'chat', model: 'gpt' });
        const turns = Array.from({ length: 6 }, (_, index) =>
          index % 2 ? answer('Message ' + index) : user('Message ' + index),
        );
        yield* f.history.append('s', turns, 'gpt');
        yield* f.history.append('s', [compaction(2, 'First summary')], 'gpt');
        yield* f.history.append('s', [compaction(4)], 'gpt');
        // The latest compaction wins; one without a summary just starts reading later.
        expect(yield* f.history.load('s')).toEqual({
          rows: turns.slice(4).map((data, index) => ({ seq: 4 + index, model: 'gpt', data })),
        });
        // The next turn logs after the compactions; reading skips them.
        yield* f.history.append('s', [user('Next')], 'gpt');
        yield* f.history.append('s', [compaction(8, 'Latest summary')], 'claude');
        const loaded = yield* f.history.load('s');
        expect(loaded.summary).toBe('Latest summary');
        expect(loaded.rows.map((row) => row.seq)).toEqual([8]);
        expect(f.entries().map((row) => [row.seq, row.type])).toEqual([
          ...turns.map((turn, index) => [index, turn.type]),
          [6, 'compaction'],
          [7, 'compaction'],
          [8, 'user'],
          [9, 'compaction'],
        ]);
      }),
    ),
);

it.live('a session records its chat, latest model, format, version and token totals', () =>
  withHistory((f) =>
    Effect.gen(function* () {
      yield* f.history.begin('s', { chatId: 'chat', model: 'connection:abc:claude' });
      f.tick(2000);
      // The chat keeps its session when its model changes; the session records the latest one.
      yield* f.history.begin('s', { chatId: 'chat', model: 'gpt' });
      yield* f.history.addUsage('s', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 });
      yield* f.history.addUsage('s', {
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
    }),
  ),
);

it.live(
  'ending a session or deleting its chat removes its history; prune drops the unreferenced',
  () =>
    withHistory((f) =>
      Effect.gen(function* () {
        for (const [session, chatId] of [
          ['kept', 'chat'],
          ['ended', 'chat'],
          ['deleted', 'gone'],
          ['orphan', 'never-saved'],
        ]) {
          yield* f.history.begin(session, { chatId, model: 'm' });
          yield* f.history.append(session, [user(session), compaction(0, 'S')], 'm');
        }
        yield* f.history.delete('ended');
        expect((yield* f.history.load('ended')).rows).toEqual([]);
        expect(f.count('messages')).toBe(3);
        expect(f.count('compactions')).toBe(3);

        const chats = yield* ChatStore;
        yield* chats.load();
        const gone = { ...newChat('gone', 'game'), agentSession: 'deleted', title: 'Gone' };
        yield* chats.flush([
          { ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' },
          gone,
        ]);
        yield* chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept', title: 'Kept' }]);
        expect(f.session('deleted')).toBeUndefined();

        yield* f.history.prune();
        expect((yield* f.history.load('kept')).rows).toHaveLength(1);
        expect(f.session('orphan')).toBeUndefined();
        expect(f.count('messages')).toBe(1);
        expect(f.count('compactions')).toBe(1);
      }),
    ),
);

it.live('a compaction logged during a turn keeps its place when the turn ends', () =>
  withHistory((f) =>
    Effect.gen(function* () {
      yield* f.history.begin('s', { chatId: 'chat', model: 'gpt' });
      yield* f.history.append('s', [user('Question')], 'gpt');
      yield* f.history.append('s', [compaction(0, 'Summary')], 'gpt');
      yield* f.history.append('s', [answer('Answer')], 'gpt');
      expect(f.entries().map((row) => [row.seq, row.type])).toEqual([
        [0, 'user'],
        [1, 'compaction'],
        [2, 'assistant'],
      ]);
      const loaded = yield* f.history.load('s');
      expect(loaded.summary).toBe('Summary');
      expect(loaded.rows.map((row) => row.seq)).toEqual([0, 2]);
    }),
  ),
);
