import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyEvent, type Chat } from '@wisp/bridge/events';
import { resetContextUsage } from '@wisp/protocol/context-usage';
import { ReplyProjection } from '@wisp/bridge/reply-stream';

test('context size follows the last model call, totals include cache only once', () => {
  const chat: Chat = {
    id: 'test',
    title: 'test',
    owner: 'game',
    status: 'working',
    messages: [],
    activity: [],
  };
  const parts = new ReplyProjection();
  const record = (inputTokens: unknown, outputTokens: unknown, cacheReadTokens = 0) =>
    applyEvent(
      chat,
      {
        type: 'usage.recorded',
        data: { kind: 'model', usage: { inputTokens, outputTokens, cacheReadTokens } },
      },
      parts,
    );
  assert.equal(record(10000, 200, 8000), true);
  assert.equal(chat.usage?.contextTokens, 10200);
  record(11000, 300, 10000);
  assert.equal(chat.usage?.contextTokens, 11300);
  assert.equal(chat.usage?.inputTokens, 21000);
  assert.equal(chat.usage?.outputTokens, 500);
  assert.equal(chat.usage?.cacheReadTokens, 18000);
  const before = structuredClone(chat.usage);
  for (const invalid of [NaN, Infinity, -1, '123', undefined]) {
    assert.equal(record(invalid, 5), false);
    assert.deepEqual(chat.usage, before);
  }
});

test('compaction preserves visible history and waits for a fresh context measurement', () => {
  const chat: Chat = {
    id: 'test',
    title: 'test',
    owner: 'game',
    status: 'working',
    messages: [{ role: 'user', text: 'Remember my guide' }],
    activity: [],
  };
  const parts = new ReplyProjection();
  const event = (type: string, data: Record<string, unknown>) =>
    applyEvent(chat, { type, data }, parts);
  const measure = (inputTokens: number) =>
    event('usage.recorded', { kind: 'model', usage: { inputTokens, outputTokens: 100 } });
  measure(70000);
  event('context.started', { kind: 'compaction', changeId: 'compact' });
  assert.equal(chat.usage?.compacting, true);
  measure(75000);
  assert.equal(chat.usage?.contextTokens, 70100, 'summary input is not the new context');
  event('context.settled', { kind: 'compaction', outcome: 'completed', changeId: 'compact' });
  assert.equal(chat.usage?.contextTokens, undefined);
  assert.equal(chat.usage?.compactions, 1);
  assert.equal(chat.usage?.compacting, false);
  measure(4000);
  assert.equal(chat.usage?.contextTokens, 4100);
  event('context.started', { kind: 'compaction' });
  event('context.settled', { kind: 'compaction', outcome: 'failed' });
  assert.equal(chat.usage?.contextTokens, 4100);
  assert.equal(chat.usage?.compactions, 1);
  assert.deepEqual(chat.messages, [{ role: 'user', text: 'Remember my guide' }]);
  resetContextUsage(chat);
  assert.equal(
    chat.usage?.contextTokens,
    undefined,
    'replacement sessions cannot inherit the old context size',
  );
  assert.equal(chat.usage?.inputTokens, 149000, 'observed usage survives session replacement');
});
