import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LegacyReplyStream as ReplyStream } from '../src/legacy-reply.ts';
import { ReplyProjection } from '../src/reply-stream.ts';
import { applyEvent, type Chat } from '../src/events.ts';
import { migrateReplies } from '../src/migrate-replies.ts';
import { projectChats } from '../src/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';
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
  assert.equal(reply.view().text, 'Ya podés leer esto.\nUna comilla: " y un emoji: 😀. [[ref:');
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
      assert.equal(
        reply
          .view()
          .parts.map((part) => (part.type === 'text' ? part.text : ''))
          .join(''),
        reply.view().text,
        'preview parts preserve the same decoded source as message text',
      );
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
  assert.equal(reply.view().text, '[[ref:missing]] [[ref:s]] `[[ref:example]]`');
  const spell = reply.view().references.s;
  assert.equal(spell.kind === 'spell' && spell.id, 122);
  assert.equal(reply.view().references.pin, undefined);
  assert.equal(reply.errors.length, 3);
});
test('reference presentation never rewrites Markdown source in code, prose or partial tokens', () => {
  const source =
    '**[[ref:missing]]** `[[ref:code]]` ``tick ` [[ref:double]]``\n' +
    '~~~text\n[[ref:fenced]]\n~~~\n\\[[ref:escaped]] [[ref:late]] unfinished [[ref:';
  const reply = new ReplyStream();
  reply.feed(text(source));
  const before = reply.view();
  assert.equal(before.text, source);
  assert.deepEqual(before.parts, [{ type: 'text', text: source }]);
  assert.deepEqual(before.references, {});
  assert.equal(before.streaming, true);
  reply.feed(record({ type: 'reference', key: 'late', kind: 'spell', id: 122, label: 'Nova' }));
  const after = reply.view();
  assert.equal(after.text, source, 'late metadata only updates the separate reference catalog');
  assert.deepEqual(after.parts, before.parts);
  assert.equal(after.references.late.kind, 'spell');
  assert.deepEqual(before.references, {}, 'earlier snapshots remain independent');
  reply.finish();
  assert.equal(reply.view().text, source);
  assert.deepEqual(reply.view().parts, before.parts);
  assert.equal(reply.view().streaming, false);
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

test('Markdown tables remain source text in live and completed addon messages', () => {
  const markdown =
    'Antes.\n\n| Pieza | Estado |\n| :--- | ---: |\n| [[ref:robe]] | Equipada |\n| Capa | En bolsas |\n\nDespués.';
  const reply = new ReplyStream();
  reply.feed(
    record({ type: 'reference', key: 'robe', kind: 'item', id: 100, label: 'Toga' }) +
      text(markdown),
  );
  const live = display(reply);
  assert.equal(live.text, markdown);
  assert.deepEqual(live.ui, []);
  assert.deepEqual(live.parts, [{ type: 'text', text: markdown }]);
  reply.finish();
  const view = display(reply);
  assert.equal(view.streaming, false);
  assert.equal(view.text, markdown);
  assert.deepEqual(view.ui, []);
  assert.deepEqual(view.parts, live.parts);
  assert.deepEqual(display(reply), view, 'transport projection must be deterministic');
});

test('unfinished Markdown cells reach the addon after many partial updates without rewriting history', () => {
  const c = chat(),
    projection = new ReplyProjection(),
    state = createSessionState([c]);
  state.activeChat = c.id;
  let now = 0;
  const feed = (chunk: string) => {
    projection.text(c, 'answer', chunk, true);
    assert.equal(projection.flush(c, now), true);
    now += 600;
    const stored = JSON.stringify(c);
    const view = projectChats(state).chats[0].messages![0];
    assert.equal(JSON.stringify(c), stored);
    assert.equal(c.messages[0].ui?.length, 0);
    assert.equal(view.streaming, true);
    assert.deepEqual(view.ui, []);
    return view;
  };
  for (let i = 0; i < 9; i++) {
    feed('Antes. ');
  }
  let markdown = '\n\n| Pieza | Estado |\n';
  feed(markdown);
  for (const delta of [
    '| --- | --- |\n| To',
    'ga | Equi',
    'pada |\n| Capa | En bol',
    'sas |\n\nDespués.',
  ]) {
    markdown += delta;
    const view = feed(delta);
    assert.equal(view.text, 'Antes. '.repeat(9) + markdown);
    assert.deepEqual(view.parts, [{ type: 'text', text: view.text }]);
  }
  projection.text(c, 'answer', undefined, false);
  assert.equal(projection.flush(c, now), true);
  const view = projectChats(state).chats[0].messages![0];
  assert.equal(view.streaming, false);
  assert.equal(view.text, 'Antes. '.repeat(9) + markdown);
  assert.deepEqual(view.parts, [{ type: 'text', text: view.text }]);
  assert.deepEqual(view.ui, []);
});

test('Markdown interpretation belongs to the addon while explicit UI keeps its source order', () => {
  const wire = 'A | B\n--- | :---:\na\\|b | `x\\|y`\n';
  const node = { id: 'markdown_table_1', kind: 'stat', label: 'Existing', value: '1' };
  const reply = new ReplyStream();
  reply.feed(text(wire) + record({ type: 'ui_node', node }) + text('Después.'));
  reply.finish();
  const view = display(reply);
  assert.deepEqual(view.ui, [node]);
  assert.deepEqual(view.parts, [
    { type: 'text', text: wire },
    { type: 'ui', id: node.id },
    { type: 'text', text: 'Después.' },
  ]);
  for (const markdown of [
    '```text\n' + wire + '```',
    'A|B\n---|---\n' + 'x'.repeat(301) + '|2',
    'A|B\n---|---\n' + '1|2\n'.repeat(21),
    'A|B\n:-|-:\n1\n2|3|extra\n4|5',
  ]) {
    const plain = new ReplyStream();
    plain.feed(markdown);
    plain.finish();
    const transported = display(plain);
    assert.deepEqual(transported.ui, []);
    assert.equal(transported.text, markdown, 'format recovery must not interpret Markdown');
    assert.deepEqual(transported.parts, [{ type: 'text', text: markdown }]);
  }
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
