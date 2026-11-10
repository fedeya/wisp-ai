import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ReplyStream } from '@wisp/bridge/reply-stream';
import { selectionValues } from '@wisp/protocol/ui-schema';
test('reply preserves text and UI order, including updates and pending prose', () => {
  const r = new ReplyStream();
  const emit = (event: unknown) => r.feed(JSON.stringify(event) + '\n');
  emit({ type: 'ui_node', node: { id: 'first', kind: 'card' } });
  emit({ type: 'text_delta', text: 'Between' });
  emit({ type: 'ui_node', node: { id: 'second', kind: 'card' } });
  emit({ type: 'ui_node', node: { id: 'child', parent: 'first', kind: 'text', text: 'Child' } });
  emit({ type: 'ui_node', node: { id: 'first', kind: 'card', title: 'Updated' } });
  r.feed('{"type":"text_delta","text":"After');
  assert.deepEqual(r.view().parts, [
    { type: 'ui', id: 'first' },
    { type: 'text', text: 'Between' },
    { type: 'ui', id: 'second' },
    { type: 'text', text: 'After' },
  ]);
  r.feed('"}\n');
  r.finish();
  assert.equal(r.view().parts.length, 4);
  assert.equal(r.view().text, 'BetweenAfter');
});
test('UI stream upserts stable components and rejects cycles, invalid inputs and executable actions', () => {
  const r = new ReplyStream();
  const node = (value: unknown) => r.feed(JSON.stringify({ type: 'ui_node', node: value }) + '\n');
  node({ id: 'card', kind: 'card', title: 'Comparison' });
  node({ id: 'stat', parent: 'card', kind: 'stat', label: 'Armor', value: '12' });
  node({ id: 'stat', parent: 'card', kind: 'stat', label: 'Armor', value: '15' });
  assert.equal(r.ui.length, 2);
  assert.equal(r.ui[1].kind === 'stat' && r.ui[1].value, '15');
  node({ id: 'card', parent: 'stat', kind: 'card' });
  node({ id: 'bad', kind: 'button', label: 'Bad', action: { kind: 'lua', code: 'x=1' } });
  node({ id: 'slider', kind: 'slider', min: 5, max: 1, step: 1, value: 2, label: 'Bad' });
  assert.equal(r.ui.length, 2);
  assert.equal(r.errors.length, 3);
  node({
    id: 'choice',
    parent: 'card',
    kind: 'select',
    label: 'Pick',
    value: 'a',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  });
  assert.deepEqual(
    { ...selectionValues(r.ui, { choice: 'b', unknown: 'ignored' }) },
    { choice: 'b' },
  );
  assert.throws(() => selectionValues(r.ui, { choice: 'unregistered' }));
  r.feed(
    '{"type":"ui_node","node":{"id":"continue","kind":"button","label":"Continue","action":{"kind":"ask","prompt":"Continue"}}} trailing garbage\n',
  );
  assert.equal(
    r.ui.at(-1)?.kind,
    'button',
    'a complete valid button should survive trailing model noise',
  );
});
