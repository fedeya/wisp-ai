import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ReplyProjection, ReplyStream } from '@wisp/bridge/reply-stream';
import { applyEvent, type Chat } from '@wisp/bridge/events';
import { migrateReplies } from '@wisp/bridge/migrate-replies';
const record = (value: unknown) => JSON.stringify(value) + '\n';
const text = (value: string) => record({ type: 'text_delta', text: value });
const chat = (): Chat => ({
  id: 'test',
  title: 'Test',
  owner: 'game',
  status: 'working',
  messages: [],
  activity: [],
});
test('one long text event becomes visible before its JSON string closes, with no duplicate at commit', () => {
  const reply = new ReplyStream();
  reply.feed('{"type":"text_delta","text":"Ya podés leer esto.\\nUna comilla: \\');
  assert.equal(reply.view().text, 'Ya podés leer esto.\nUna comilla: ');
  reply.feed('" y un emoji: \\uD83D');
  assert.equal(reply.view().text, 'Ya podés leer esto.\nUna comilla: " y un emoji: ');
  reply.feed('\\uDE00. [[ref:');
  assert.equal(reply.view().text, 'Ya podés leer esto.\nUna comilla: " y un emoji: 😀. ');
  reply.feed(
    'nova]]"}\n' +
      record({ type: 'reference', key: 'nova', kind: 'spell', id: 122, label: 'Nova' }),
  );
  reply.finish();
  assert.equal(
    reply.view().text,
    'Ya podés leer esto.\nUna comilla: " y un emoji: 😀. [[ref:nova]]',
  );
});
test('arbitrary stream boundaries preserve escapes, Unicode and late references without exposing JSON', () => {
  const wire =
    text('Sí, "usá" [[ref:') +
    text('nova]].\nDespués seguí.') +
    record({ type: 'reference', key: 'nova', kind: 'spell', id: 122, label: 'Nova de Escarcha' });
  for (let split = 1; split <= 31; split++) {
    const reply = new ReplyStream();
    for (let i = 0; i < wire.length; i += split) {
      reply.feed(wire.slice(i, i + split));
      assert.ok(!reply.view().text.includes('"type"'));
      assert.ok(!reply.view().text.endsWith('[[ref:'));
    }
    reply.finish();
    assert.equal(reply.view().text, 'Sí, "usá" [[ref:nova]].\nDespués seguí.');
    assert.equal(reply.view().references.nova.kind, 'spell');
    assert.equal(reply.errors.length, 0);
  }
});
test('invalid references, conflicting keys and missing IDs fail once without guessing or legacy fallback', () => {
  const reply = new ReplyStream();
  reply.feed(
    '[Nova](spell:122)\n' +
      record({
        type: 'reference',
        key: 'pin',
        kind: 'map',
        mapId: 1,
        label: 'Here',
        x: 101,
        y: 2,
      }) +
      record({ type: 'reference', key: 's', kind: 'spell', id: 122, label: 'Nova' }) +
      record({ type: 'reference', key: 's', kind: 'spell', id: 116, label: 'Bolt' }) +
      text('[[ref:missing]] [[ref:s]] `[[ref:example]]`'),
  );
  reply.finish();
  reply.finish();
  assert.equal(reply.view().text, '(reference unavailable) [[ref:s]] `[[ref:example]]`');
  const spell = reply.view().references.s;
  assert.equal(spell.kind === 'spell' && spell.id, 122);
  assert.equal(reply.view().references.pin, undefined);
  assert.equal(reply.errors.length, 3);
});
test('hundreds of text deltas spend at most eight partial updates, recover completion, and never leak reasoning', () => {
  const c = chat(),
    projection = new ReplyProjection();
  applyEvent(
    c,
    {
      type: 'content.delta',
      data: { partId: 'secret', kind: 'reasoning', delta: text('private') },
    },
    projection,
  );
  applyEvent(
    c,
    { type: 'content.delta', data: { partId: 'secret', delta: text('private2') } },
    projection,
  );
  const state = projection.stream('answer');
  let updates = 0;
  for (let i = 0; i < 500; i++) {
    state.reply.feed(text('a'));
    if (projection.flush(c, i * 2000)) {
      updates++;
    }
  }
  assert.equal(updates, 8);
  assert.equal(c.messages.length, 1);
  applyEvent(
    c,
    {
      type: 'content.completed',
      data: { partId: 'answer', kind: 'text', value: text('a'.repeat(500) + ' final') },
    },
    projection,
  );
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0].text, 'a'.repeat(500) + ' final');
  assert.equal(c.messages[0].streaming, false);
  assert.ok(!JSON.stringify(c).includes('private'));
});

test('legacy reply title metadata stays invisible and cannot rename a conversation', () => {
  const c = chat(),
    projection = new ReplyProjection();
  const stream = projection.stream('answer').reply;
  stream.feed(record({ type: 'conversation_title', title: 'Next quest in Ratchet' }));
  projection.flush(c, 0);
  assert.notEqual(c.title, 'Next quest in Ratchet');
  assert.notEqual(c.titleGenerated, true);
  assert.equal(c.messages.length, 0);
  stream.feed(text('Turn in your completed quest.'));
  projection.flush(c, 1);
  assert.equal(c.messages[0].text, 'Turn in your completed quest.');
  stream.feed(record({ type: 'conversation_title', title: 'Do not overwrite' }));
  projection.flush(c, 2000);
  assert.notEqual(c.title, 'Next quest in Ratchet');
});
test('migration preserves user links and tools, converts verified references, and is idempotent', () => {
  const c = chat();
  c.messages = [
    { role: 'user', text: '|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h' },
    { role: 'tool', text: 'Reading' },
    {
      role: 'assistant',
      text: '**Descarga de Escarcha mejorada** y [Zona](map:1411:45:62.5). [Nova](macro:4e6f7661) `Descarga de Escarcha mejorada`. Unknown Quest.',
    },
  ];
  const originalUser = c.messages[0].text;
  assert.deepEqual(migrateReplies([c]), { messages: 1, references: 3 });
  const message = c.messages[2];
  assert.equal(c.messages[0].text, originalUser);
  assert.equal(c.messages[1].text, 'Reading');
  assert.ok(message.text.includes('**[[ref:ref3]]**'));
  assert.ok(message.text.includes('`Descarga de Escarcha mejorada`'));
  assert.equal(
    message.references?.ref3.kind === 'spell' && message.references.ref3.payload,
    'spell:11070:0',
  );
  const saved = JSON.stringify(c);
  assert.deepEqual(migrateReplies([c]), { messages: 0, references: 0 });
  assert.equal(JSON.stringify(c), saved);
});
