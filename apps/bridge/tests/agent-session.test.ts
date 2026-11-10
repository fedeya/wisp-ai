import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionNotActiveError, type Client } from 'eve/client';
import { sendChatTurn } from '../src/agent-session.ts';
import { turnInput, visibleUserText } from '../src/context.ts';
import type { Chat } from '../src/events.ts';

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

test.each(['new', 'inactive'])(
  'a %s session restores assistant history from original replies instead of cached text',
  async (mode) => {
    const f = fixture(mode === 'inactive' ? new SessionNotActiveError() : undefined);
    if (mode === 'new') {
      f.chat.eveId = undefined;
    }
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
    await sendChatTurn(f.client, f.chat, turnInput('What is next?', undefined, f.chat));
    const input = f.sent.at(-1)!.input;
    const packed = /<historical_conversation>\n([^\n]*)\n<\/historical_conversation>/.exec(input);
    assert.ok(packed);
    const history = JSON.parse(packed[1]);
    assert.deepEqual(history, [
      { role: 'user', text: 'Follow this guide' },
      { role: 'assistant', text: markdown },
      { role: 'assistant', text: 'Respuesta original en texto normal.' },
      { role: 'assistant', text: 'Legacy reply without a source.' },
    ]);
    assert.equal(JSON.stringify(f.chat.messages), before);
    assert.equal(visibleUserText(input), 'What is next?');
    assert.equal(f.created(), 1);
  },
);

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

test('restored original replies keep the existing history count and per-message limits', async () => {
  const f = fixture();
  f.chat.eveId = undefined;
  f.chat.messages = Array.from({ length: 15 }, (_, index) => ({
    role: 'assistant',
    text: '',
    rawReply: JSON.stringify({ type: 'text_delta', text: String(index) + ': ' + 'x'.repeat(2500) }),
  }));
  f.chat.messages.push({ role: 'user', text: 'What is next?' });
  await sendChatTurn(f.client, f.chat, turnInput('What is next?', undefined, f.chat));
  const packed = /<historical_conversation>\n([^\n]*)\n<\/historical_conversation>/.exec(
    f.sent[0].input,
  );
  assert.ok(packed);
  const history = JSON.parse(packed[1]) as { role: string; text: string }[];
  assert.equal(history.length, 12);
  assert.ok(history[0].text.startsWith('3: '));
  assert.ok(history.at(-1)!.text.startsWith('14: '));
  assert.ok(history.every((message) => message.text.length === 2000));
});
