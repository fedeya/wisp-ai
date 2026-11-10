import { ReplyProjection } from '../src/reply-stream.ts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyEvent, type Chat } from '../src/events.ts';
import { rebuildHistory } from '../src/history.ts';
test('UI gets tool states and final text, never hidden reasoning', () => {
  const chat: Chat = {
    id: 'test',
    owner: 'game',
    title: 'test',
    status: 'working',
    messages: [],
    activity: [],
  };
  const parts = new ReplyProjection();
  applyEvent(
    chat,
    {
      type: 'call.requested',
      data: {
        callId: '1',
        capability: { name: 'query_character', label: 'Reading spells', kind: 'tool' },
      },
    },
    parts,
  );
  assert.equal(chat.activity[0].status, 'running');
  applyEvent(chat, { type: 'call.settled', data: { callId: '1', outcome: 'completed' } }, parts);
  applyEvent(
    chat,
    {
      type: 'content.completed',
      data: { partId: 'r', kind: 'reasoning', phase: 'narration', value: 'private' },
    },
    parts,
  );
  applyEvent(
    chat,
    {
      type: 'content.completed',
      data: {
        partId: 'a',
        kind: 'text',
        phase: 'reply',
        value: JSON.stringify({ type: 'text_delta', text: 'Ya conocés Nova de Escarcha.' }),
      },
    },
    parts,
  );
  assert.equal(chat.activity[0].status, 'completed');
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].role, 'tool');
  assert.equal(chat.messages[0].tool?.status, 'completed');
  assert.equal(chat.messages[1].text, 'Ya conocés Nova de Escarcha.');
});
test('tool calls stay in chronological history across subsequent turns', () => {
  const chat: Chat = {
    id: 'test',
    owner: 'game',
    title: 'test',
    status: 'working',
    messages: [{ role: 'user', text: 'first' }],
    activity: [],
  };
  const parts = new ReplyProjection();
  applyEvent(
    chat,
    {
      type: 'call.requested',
      data: { callId: 'first-tool', capability: { name: 'query_character', kind: 'tool' } },
    },
    parts,
  );
  assert.equal(
    chat.messages.at(-1)?.role,
    'tool',
    'the invocation is visible before any final answer',
  );
  applyEvent(
    chat,
    {
      type: 'content.completed',
      data: {
        partId: 'first-answer',
        kind: 'text',
        phase: 'reply',
        value: JSON.stringify({ type: 'text_delta', text: 'first answer' }),
      },
    },
    parts,
  );
  chat.activity = [];
  chat.messages.push({ role: 'user', text: 'second' });
  applyEvent(
    chat,
    {
      type: 'content.completed',
      data: {
        partId: 'second-answer',
        kind: 'text',
        phase: 'reply',
        value: JSON.stringify({ type: 'text_delta', text: 'second answer' }),
      },
    },
    new ReplyProjection(),
  );
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'tool', 'assistant', 'user', 'assistant'],
  );
  assert.equal(chat.messages[1].tool?.name, 'query_character');
});
test('new-format event history reconstructs historical tool calls without duplicating user messages', () => {
  const chat: Chat = {
    id: 'old',
    owner: 'game',
    title: 'old',
    status: 'done',
    messages: [
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'Answer' },
    ],
    activity: [],
  };
  const restored = rebuildHistory(chat, [
    { type: 'delivery.consumed', data: { parts: [{ kind: 'text', text: 'Question' }] } },
    {
      type: 'call.requested',
      data: { callId: 'tool', capability: { name: 'query_character', kind: 'tool' } },
    },
    { type: 'call.settled', data: { callId: 'tool', outcome: 'completed' } },
    {
      type: 'content.completed',
      data: {
        partId: 'answer',
        kind: 'text',
        phase: 'reply',
        value: JSON.stringify({ type: 'text_delta', text: 'Answer' }),
      },
    },
  ]);
  assert.deepEqual(
    restored?.map((m) => m.role),
    ['user', 'tool', 'assistant'],
  );
  assert.equal(rebuildHistory(chat, []), null);
});
