import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LegacyReplyStream as ReplyStream } from '../src/legacy-reply.ts';
import { ReplyProjection } from '../src/reply-stream.ts';
import { type Chat } from '../src/events.ts';
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
  assert.equal(reply.view().ui.length, 0, 'generated tables remain presentation only');
  assert.equal(display(reply).ui![0].kind, 'table', 'tables render before completion');
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
    { type: 'text', text: '\n\nDespués.' },
  ]);
  assert.deepEqual(display(reply), view, 'projection must be deterministic');
});

test('tables grow within plain text after many partial updates without rewriting history', () => {
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
    assert.equal(JSON.stringify(c), stored, 'rendering does not modify the stored reply');
    assert.equal(c.messages[0].ui?.length, 0);
    assert.equal(view.streaming, true);
    return view;
  };
  for (let i = 0; i < 9; i++) {
    feed('Antes. ');
  }
  let markdown = '\n\n| Pieza | Estado |\n';
  assert.equal(feed(markdown).ui?.length, 0);
  let tableId: string | undefined;
  for (const [delta, rows] of [
    ['| --- | --- |\n| To', [['To', '']]],
    ['ga | Equi', [['Toga', 'Equi']]],
    [
      'pada |\n| Capa | En bol',
      [
        ['Toga', 'Equipada'],
        ['Capa', 'En bol'],
      ],
    ],
    [
      'sas |\n\nDespués.',
      [
        ['Toga', 'Equipada'],
        ['Capa', 'En bolsas'],
      ],
    ],
  ] as const) {
    markdown += delta;
    const view = feed(delta);
    const table = view.ui![0];
    assert.equal(table.kind, 'table');
    if (table.kind === 'table') {
      assert.deepEqual(table.rows, rows);
    }
    tableId ??= table.id;
    assert.equal(table.id, tableId, 'the table keeps its identity while cells grow');
    assert.equal(view.text, 'Antes. '.repeat(9) + markdown);
    assert.equal(view.parts?.filter((part) => part.type === 'ui').length, 1);
  }
  projection.text(c, 'answer', undefined, false);
  assert.equal(projection.flush(c, now), true);
  const view = projectChats(state).chats[0].messages![0];
  assert.equal(view.streaming, false);
  assert.equal(view.ui![0].id, tableId);
  assert.deepEqual(view.parts, [
    { type: 'text', text: 'Antes. '.repeat(9) + '\n\n' },
    { type: 'ui', id: tableId },
    { type: 'text', text: '\n\nDespués.' },
  ]);
  assert.equal(c.messages[0].text, 'Antes. '.repeat(9) + markdown);
  assert.equal(c.messages[0].ui?.length, 0);
});

test('table conversion handles escaped/code pipes, code fences, limits and existing component IDs', () => {
  const wire = 'A | B\n--- | :---:\na\\|b | `x\\|y`\n';
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
    '    A | B\n    --- | ---\n    1 | 2\n',
    '> A | B\n> --- | ---\n> 1 | 2\n',
    '- A | B\n  --- | ---\n  1 | 2\n',
    '<pre>\n' + wire + '</pre>\n',
    'A | B\n--- | ---\n',
    'A | B | C | D | E | F | G\n---|---|---|---|---|---|---\n1|2|3|4|5|6|7\n',
    'A | B\n--- | ---\n' + 'x'.repeat(301) + ' | 2\n',
    'A | B\n--- | ---\n' + '1 | 2\n'.repeat(21),
  ]) {
    const stream = new ReplyStream();
    stream.feed(text(raw));
    assert.equal(display(stream).ui?.length ?? 0, 0, 'streaming follows the same GFM limits');
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

test('table interpretation follows GFM delimiters and normalizes short or extra cells', () => {
  const markdown = 'A | B\n:- | -:\n1\n2 | 3 | ignored\n4 | 5\n';
  const reply = new ReplyStream();
  reply.feed(text(markdown));
  reply.finish();
  const view = display(reply),
    table = view.ui![0];
  assert.equal(table.kind, 'table');
  if (table.kind === 'table') {
    assert.deepEqual(table.columns, [
      { label: 'A', align: 'left' },
      { label: 'B', align: 'right' },
    ]);
    assert.deepEqual(table.rows, [
      ['1', ''],
      ['2', '3'],
      ['4', '5'],
    ]);
  }
  assert.equal(reply.view().text, markdown);
  assert.equal(view.text, markdown, 'the original text remains available, including extra cells');
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
