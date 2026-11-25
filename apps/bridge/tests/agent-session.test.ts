import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sendChatTurn, type AgentEngine } from '../src/agent/agent-session.ts';
import type { TurnInput } from '@wisp/agent/engine';
import { turnInput } from '../src/chat/context.ts';
import type { Chat } from '../src/chat/events.ts';

function fixture() {
  const chat: Chat = {
    id: 'chat',
    agentSession: 'old',
    title: 'Test',
    titleGenerated: true,
    owner: 'game',
    status: 'working',
    activity: [],
    messages: [
      { role: 'user', text: 'Follow this guide' },
      { role: 'assistant', text: 'We can use that guide.' },
      { role: 'system', text: 'private diagnostic' },
      { role: 'user', text: 'What is next?' },
    ],
  };
  const sent: { id: string; input: TurnInput }[] = [];
  let created = 0;
  const delivery = {
    events: (async function* () {})(),
    result: Promise.resolve({ status: 'completed' as const }),
  };
  const engine: AgentEngine = {
    newSessionId: () => 'new-' + ++created,
    send: (id, input) => {
      sent.push({ id, input });
      assert.equal(
        chat.agentSession,
        id,
        'bridge lookup must be updated before memory recall runs',
      );
      return delivery;
    },
    end: async () => {},
  };
  return { chat, engine, sent, created: () => created, delivery };
}

const signal = () => AbortSignal.timeout(1000);

function packedHistory(input: TurnInput) {
  assert.ok(input.history);
  return input.history;
}

test('a new session starts with bounded visible history', () => {
  const f = fixture();
  f.chat.agentSession = undefined;
  const input = turnInput('What is next?', undefined, f.chat);
  assert.equal(sendChatTurn(f.engine, f.chat, input, signal()), f.delivery);
  assert.equal(f.created(), 1);
  assert.equal(f.chat.agentSession, 'new-1');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(packedHistory(f.sent[0]!.input), [
    { role: 'user', text: 'Follow this guide' },
    { role: 'assistant', text: 'We can use that guide.' },
  ]);
  assert.equal(f.sent[0]!.input.text, 'What is next?');
});

test('a new session restores assistant history from original replies instead of cached text', () => {
  const f = fixture();
  f.chat.agentSession = undefined;
  const markdown = '| Pieza | Estado |\n|---|---|\n| Toga | Equipada |';
  f.chat.messages.splice(
    1,
    1,
    {
      role: 'assistant',
      text: '',
      rawReply: JSON.stringify({ type: 'text_delta', text: markdown }),
      streaming: false,
    },
    {
      role: 'assistant',
      text: 'obsolete cached interpretation',
      rawReply: 'Respuesta original en texto normal.',
      streaming: false,
    },
    { role: 'assistant', text: 'Legacy reply without a source.' },
    { role: 'assistant', text: 'stale content from malformed source', rawReply: '{broken' },
    { role: 'assistant', text: 'stale metadata preview', rawReply: '{"type":"no_tip"}' },
    { role: 'assistant', text: 'unfinished preview', rawReply: 'unfinished', streaming: true },
    { role: 'tool', text: 'private tool diagnostic' },
  );
  const before = JSON.stringify(f.chat.messages);
  sendChatTurn(f.engine, f.chat, turnInput('What is next?', undefined, f.chat), signal());
  const input = f.sent.at(-1)!.input;
  assert.deepEqual(packedHistory(input), [
    { role: 'user', text: 'Follow this guide' },
    { role: 'assistant', text: markdown },
    { role: 'assistant', text: 'Respuesta original en texto normal.' },
    { role: 'assistant', text: 'Legacy reply without a source.' },
  ]);
  assert.equal(JSON.stringify(f.chat.messages), before);
  assert.equal(input.text, 'What is next?');
  assert.equal(f.created(), 1);
});

test('a live session is reused with the message as sent', () => {
  const live = fixture();
  sendChatTurn(live.engine, live.chat, { text: 'Message' }, signal());
  assert.equal(live.created(), 0);
  assert.deepEqual(live.sent, [{ id: 'old', input: { text: 'Message' } }]);
});

test('restored original replies keep the existing history count and per-message limits', () => {
  const f = fixture();
  f.chat.agentSession = undefined;
  f.chat.messages = Array.from({ length: 15 }, (_, index) => ({
    role: 'assistant',
    text: '',
    rawReply: JSON.stringify({ type: 'text_delta', text: String(index) + ': ' + 'x'.repeat(2500) }),
  }));
  f.chat.messages.push({ role: 'user', text: 'What is next?' });
  sendChatTurn(f.engine, f.chat, turnInput('What is next?', undefined, f.chat), signal());
  const history = packedHistory(f.sent[0]!.input);
  assert.equal(history.length, 12);
  assert.ok(history[0]!.text.startsWith('3: '));
  assert.ok(history.at(-1)!.text.startsWith('14: '));
  assert.ok(history.every((message) => message.text.length === 2000));
});
