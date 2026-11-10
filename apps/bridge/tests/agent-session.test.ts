import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionNotActiveError, type Client } from 'eve/client';
import { sendChatTurn } from '@wisp/bridge/agent-session';
import { turnInput, visibleUserText } from '@wisp/bridge/context';
import type { Chat } from '@wisp/bridge/events';

function fixture(error?: Error) {
  const chat: Chat = {
    id: 'chat',
    eveId: 'old',
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
  const sent: { id: string; input: string }[] = [];
  let created = 0;
  const delivery = { status: 'accepted' };
  const session = (id: string) => ({
    id,
    send: async (input: string) => {
      sent.push({ id, input });
      if (id === 'old' && error) {
        throw error;
      }
      assert.equal(chat.eveId, id, 'bridge lookup must be updated before memory recall runs');
      return delivery;
    },
  });
  const client = {
    sessions: { attach: session, create: async () => ({ session: session('new-' + ++created) }) },
  } as unknown as Pick<Client, 'sessions'>;
  return { chat, client, sent, created: () => created, delivery };
}

test('an inactive session is replaced once and keeps bounded visible history', async () => {
  const f = fixture(new SessionNotActiveError());
  const input = turnInput('What is next?', undefined, f.chat);
  assert.equal(await sendChatTurn(f.client, f.chat, input), f.delivery);
  assert.equal(f.created(), 1);
  assert.equal(f.chat.eveId, 'new-1');
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent[1].input.includes('<historical_conversation>'));
  assert.ok(f.sent[1].input.includes('Follow this guide'));
  assert.ok(!f.sent[1].input.includes('private diagnostic'));
  assert.equal(visibleUserText(f.sent[1].input), 'What is next?');
});

test('live sessions are reused and ambiguous failures are never resent', async () => {
  const live = fixture();
  await sendChatTurn(live.client, live.chat, 'Message');
  assert.equal(live.created(), 0);
  assert.equal(live.sent.length, 1);
  const failed = fixture(new Error('Network interrupted'));
  await assert.rejects(
    () => sendChatTurn(failed.client, failed.chat, 'Message'),
    /Network interrupted/,
  );
  assert.equal(failed.created(), 0);
  assert.equal(failed.sent.length, 1);
});
