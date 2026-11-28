import { expect, it, layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import * as MemoryHistory from '../src/session/memory-history.ts';
import * as SessionHistory from '../src/session/session-history.ts';
import type { Entry } from '../src/session/session-message.ts';

const user = (text: string): Entry => ({ type: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): Entry => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { created: 0 },
});

/** The engine's history over an in-memory store the test also reads. */
const memoryHistory = SessionHistory.layer.pipe(Layer.provideMerge(MemoryHistory.layer));

layer(memoryHistory)('SessionHistory over the in-memory store', (it) => {
  it.effect('loads the messages from the latest compaction on, with its summary', () =>
    Effect.gen(function* () {
      const history = yield* SessionHistory.Service;
      yield* history.append('compacted', [user('First'), assistant('One')], 'gpt-a');
      yield* history.append('compacted', [{ type: 'compaction', keptFrom: 1 }], 'gpt-a');
      yield* history.append(
        'compacted',
        [user('Second'), { type: 'compaction', keptFrom: 3, summary: 'Asked twice.' }],
        'gpt-b',
      );
      yield* history.append('compacted', [assistant('Two')], 'gpt-c');
      const loaded = yield* history.load('compacted');
      expect(loaded.summary).toBe('Asked twice.');
      expect(loaded.messages).toEqual([
        { seq: 3, model: 'gpt-b', message: user('Second') },
        { seq: 5, model: 'gpt-c', message: assistant('Two') },
      ]);
    }),
  );

  it.effect('a compaction without a summary loads no summary', () =>
    Effect.gen(function* () {
      const history = yield* SessionHistory.Service;
      yield* history.append('unsummarized', [user('First'), assistant('One')], 'gpt-a');
      yield* history.append('unsummarized', [{ type: 'compaction', keptFrom: 1 }], 'gpt-a');
      const loaded = yield* history.load('unsummarized');
      expect(loaded).toEqual({ messages: [{ seq: 1, model: 'gpt-a', message: assistant('One') }] });
      expect(loaded).not.toHaveProperty('summary');
    }),
  );

  it.effect('logs copies, and an empty append logs nothing', () =>
    Effect.gen(function* () {
      const history = yield* SessionHistory.Service;
      const memory = yield* MemoryHistory.Service;
      yield* history.append('empty', [], 'gpt-a');
      expect(yield* memory.has('empty')).toBe(false);
      const part: { type: 'text'; text: string } = { type: 'text', text: 'Before' };
      yield* history.append('copied', [{ type: 'user', content: [part] }], 'gpt-a');
      part.text = 'After';
      expect(yield* memory.entries('copied')).toEqual([{ entry: user('Before'), model: 'gpt-a' }]);
      const loaded = yield* history.load('copied');
      expect(loaded.messages[0]?.message).toEqual(user('Before'));
    }),
  );

  it.effect('a session keeps its chat, takes each turn’s model and adds up its tokens', () =>
    Effect.gen(function* () {
      const history = yield* SessionHistory.Service;
      const memory = yield* MemoryHistory.Service;
      yield* history.addUsage('totals', { inputTokens: 5, outputTokens: 5 });
      expect(yield* memory.session('totals')).toBeUndefined();
      yield* history.begin('totals', { chatId: 'chat', model: 'gpt-a' });
      yield* history.addUsage('totals', { inputTokens: 20, outputTokens: 10 });
      yield* history.begin('totals', { chatId: 'other', model: 'gpt-b' });
      yield* history.addUsage('totals', { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 });
      expect(yield* memory.session('totals')).toEqual({
        chatId: 'chat',
        model: 'gpt-b',
        inputTokens: 23,
        outputTokens: 12,
      });
      yield* history.append('totals', [user('Hi')], 'gpt-b');
      yield* history.delete('totals');
      expect(yield* memory.session('totals')).toBeUndefined();
      expect(yield* memory.has('totals')).toBe(false);
    }),
  );
});

/** The engine's history over a store that returns `rows` for every load. */
const storedRows = (rows: SessionHistory.StoredRow[]) =>
  SessionHistory.layer.pipe(
    Layer.provide(
      Layer.effect(
        SessionHistory.HistoryStore,
        Effect.map(MemoryHistory.make, (memory) =>
          SessionHistory.HistoryStore.of({ ...memory, load: () => Effect.succeed({ rows }) }),
        ),
      ),
    ),
  );

it.effect('a row that does not decode fails the load instead of replaying it', () =>
  Effect.gen(function* () {
    const history = yield* SessionHistory.Service;
    const failure = yield* Effect.flip(history.load('broken'));
    expect(failure).toMatchObject({ _tag: 'HistoryError', operation: 'load' });
  }).pipe(
    Effect.provide(
      storedRows([
        { seq: 0, model: 'gpt-a', data: user('Fine') },
        { seq: 1, model: 'gpt-a', data: { type: 'user', content: 'not a list' } },
      ]),
    ),
  ),
);

it.effect('a failed store call reaches the engine as its HistoryError', () => {
  const cause = new Error('The disk is full.');
  return Effect.gen(function* () {
    const history = yield* SessionHistory.Service;
    const failure = yield* Effect.flip(history.append('full', [user('Hi')], 'gpt-a'));
    expect(failure).toMatchObject({ _tag: 'HistoryError', operation: 'append', cause });
  }).pipe(
    Effect.provide(
      SessionHistory.layer.pipe(
        Layer.provide(
          Layer.effect(
            SessionHistory.HistoryStore,
            Effect.map(MemoryHistory.make, (memory) =>
              SessionHistory.HistoryStore.of({
                ...memory,
                append: () =>
                  Effect.fail(new SessionHistory.HistoryError({ operation: 'append', cause })),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
