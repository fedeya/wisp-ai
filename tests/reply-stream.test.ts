import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ReplyProjection, ReplyStream } from '@wisp/bridge/reply-stream';
import { applyEvent, type Chat } from '@wisp/bridge/events';
import { migrateReplies } from '@wisp/bridge/migrate-replies';
import { projectChats } from '@wisp/bridge/chat-projection';
import { createSessionState } from '@wisp/bridge/session-state';
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
function display(reply: ReplyStream) {
  const c = chat();
  c.messages.push({ role: 'assistant', ...reply.view() });
  const state = createSessionState([c]);
  state.activeChat = c.id;
  return projectChats(state).chats[0].messages![0];
}
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

test('plain assistant prose recovers only on completion without duplicate messages or tool replay', () => {
  const c = chat(),
    projection = new ReplyProjection();
  const prose = 'Revisé tu equipo.\n\nCompará las estadísticas antes de reemplazarlo.';
  let received = '';
  for (const delta of [prose.slice(0, 15), prose.slice(15)]) {
    received += delta;
    applyEvent(
      c,
      { type: 'content.delta', data: { partId: 'reply', kind: 'text', delta } },
      projection,
    );
    assert.equal(c.messages[0].rawReply, received);
    const state = createSessionState([c]);
    state.activeChat = c.id;
    assert.equal(
      projectChats(state).chats[0].messages?.length,
      0,
      'undecoded source stays hidden while streaming',
    );
  }
  applyEvent(
    c,
    { type: 'content.completed', data: { partId: 'reply', kind: 'text', value: prose } },
    projection,
  );
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0].role, 'assistant');
  assert.equal(c.messages[0].text, prose);
  assert.equal(c.messages[0].streaming, false);
  assert.equal(projection.stream('reply').reply.recoveredPlainText, true);
  assert.deepEqual(c.messages[0].references, {});
  assert.equal(projection.flush(c, Date.now(), true), false);
});

test('plain-text recovery never exposes malformed protocol or reasoning and stays bounded', () => {
  for (const raw of [
    '{"type":"text_delta","text":"unfinished',
    '[{"type":"text_delta","text":"metadata"}]',
    '```json\n{"type":"reference","key":"private"}\n```',
    'Introduction\n{"type":"unknown","private":"metadata"}',
    'Introduction\n{ broken protocol',
    '"type": "reference", "key": "private"',
  ]) {
    const reply = new ReplyStream();
    reply.feed(raw);
    reply.finish();
    assert.equal(reply.recoveredPlainText, false, raw);
    assert.equal(reply.view().text, '', raw);
  }
  const c = chat(),
    projection = new ReplyProjection();
  applyEvent(
    c,
    {
      type: 'content.completed',
      data: { partId: 'secret', kind: 'reasoning', value: 'private prose' },
    },
    projection,
  );
  assert.equal(c.messages.length, 0);
  const reply = new ReplyStream();
  reply.feed('x'.repeat(19999) + '😀more');
  reply.finish();
  reply.finish();
  assert.equal(reply.view().text, 'x'.repeat(19999));
});

test('completed Markdown tables become native UI between prose and keep transcript text', () => {
  const markdown =
    'Antes.\n\n| Pieza | Estado |\n| :--- | ---: |\n| [[ref:robe]] | Equipada |\n| Capa | En bolsas |\n\nDespués.';
  const reply = new ReplyStream();
  reply.feed(
    record({ type: 'reference', key: 'robe', kind: 'item', id: 100, label: 'Toga' }) +
      text(markdown),
  );
  assert.equal(reply.view().ui.length, 0, 'partial tables must not change the layout');
  reply.finish();
  assert.equal(
    reply.view().ui.length,
    0,
    'the stored message keeps Markdown rather than generated table nodes',
  );
  const view = display(reply);
  assert.equal(view.text, markdown);
  const table = view.ui![0];
  assert.equal(table.kind, 'table');
  if (table.kind !== 'table') {
    return;
  }
  assert.deepEqual(table.columns, [
    { label: 'Pieza', align: 'left' },
    { label: 'Estado', align: 'right' },
  ]);
  assert.deepEqual(table.rows, [
    ['[[ref:robe]]', 'Equipada'],
    ['Capa', 'En bolsas'],
  ]);
  assert.deepEqual(view.parts, [
    { type: 'text', text: 'Antes.\n\n' },
    { type: 'ui', id: table.id },
    { type: 'text', text: '\nDespués.' },
  ]);
  assert.deepEqual(display(reply), view, 'projection must be deterministic');
});

test('table conversion handles escaped/code pipes, code fences, limits and existing component IDs', () => {
  const wire = 'A | B\n--- | :---:\na\\|b | `x|y`\n';
  const reply = new ReplyStream();
  reply.feed(
    record({
      type: 'ui_node',
      node: { id: 'markdown_table_1', kind: 'stat', label: 'Existing', value: '1' },
    }) + text(wire),
  );
  reply.finish();
  const table = display(reply).ui![1];
  assert.equal(table.kind, 'table');
  if (table.kind !== 'table') {
    return;
  }
  assert.notEqual(table.id, 'markdown_table_1');
  assert.deepEqual(table.rows, [['a|b', '`x|y`']]);
  for (const raw of [
    '```text\n' + wire + '```',
    '~~~\n' + wire + '~~~',
    'A | B\n--- | ---\n1 | 2 | 3\n',
    'A | B\n--- | ---\n' + '1 | 2\n'.repeat(21),
  ]) {
    const stream = new ReplyStream();
    stream.feed(text(raw));
    stream.finish();
    assert.equal(display(stream).ui?.length ?? 0, 0);
    const first = stream.view().parts[0];
    assert.equal(first.type === 'text' && first.text, raw);
  }
  const plain = new ReplyStream();
  plain.feed(wire);
  plain.finish();
  assert.equal(display(plain).ui![0].kind, 'table', 'format recovery and table conversion compose');
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
