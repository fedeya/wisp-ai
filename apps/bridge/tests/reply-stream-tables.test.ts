import { test, expect } from 'vitest';
import { uiNode } from '@wisp/protocol/ui-schema';
import { ReplyStream } from '@wisp/bridge/reply-stream';
const sample = {
  id: 'gear',
  kind: 'table',
  columns: [{ label: 'Pieza' }, { label: 'Armadura', align: 'right' }],
  rows: [['Toga', '12']],
};
test('tables validate bounded rectangular string cells before replacing existing UI', () => {
  const reply = new ReplyStream();
  const emit = (node: unknown) => reply.feed(JSON.stringify({ type: 'ui_node', node }) + '\n');
  emit(sample);
  expect(reply.ui).toEqual([sample]);
  for (const invalid of [
    { ...sample, columns: [{ label: 'Only one' }] },
    { ...sample, columns: [{ label: 'Pieza' }, { label: 'Armadura', align: 'bad' }] },
    { ...sample, rows: [['Toga']] },
    { ...sample, rows: [['Toga', 12]] },
    { ...sample, rows: [] },
    { ...sample, rows: Array.from({ length: 21 }, () => ['Toga', '12']) },
    { ...sample, rows: [['x'.repeat(301), '12']] },
  ]) {
    expect(uiNode.safeParse(invalid).success).toBe(false);
    emit(invalid);
    expect(reply.ui).toEqual([sample]);
  }
});
