import { test, expect } from 'vitest';
import { uiNode, validateNode } from '@wisp/protocol/ui-schema';
import { LegacyReplyStream as ReplyStream } from '../src/legacy-reply.ts';
const sample = {
  id: 'sim',
  kind: 'comparison',
  title: 'Rotaciones',
  unit: 'DPS',
  baseline: 'frost',
  winner: 'mixed',
  winnerLabel: 'Mejor DPS',
  items: [
    { id: 'mixed', label: 'Misiles + Explosión', value: 25.28 },
    { id: 'frost', label: 'Escarcha', value: 20.65 },
  ],
};
test('comparison stream validates metrics and references before replacing a component', () => {
  const stream = new ReplyStream();
  const emit = (node: unknown) => stream.feed(JSON.stringify({ type: 'ui_node', node }) + '\n');
  emit(sample);
  expect(stream.ui).toHaveLength(1);
  expect(stream.ui[0]).toEqual(sample);
  for (const invalid of [
    { ...sample, winner: 'missing' },
    { ...sample, baseline: 'missing' },
    { ...sample, precision: 5 },
    { ...sample, precision: -1 },
    { ...sample, precision: 1.5 },
    { ...sample, items: [sample.items[0], sample.items[0]] },
    { ...sample, items: [{ ...sample.items[0], value: -1 }, sample.items[1]] },
    { ...sample, items: [sample.items[0]] },
    {
      ...sample,
      items: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: 'A', value: i })),
    },
  ]) {
    emit(invalid);
  }
  // The stream keeps a bounded error list; every invalid update preserves the previous node.
  expect(stream.errors).toHaveLength(8);
  expect(stream.ui[0]).toEqual(sample);
  expect(() =>
    uiNode.parse({ ...sample, items: [{ ...sample.items[0], value: Infinity }, sample.items[1]] }),
  ).toThrow();
  const lowerWins = uiNode.parse({ ...sample, unit: 'ms', winner: 'frost' });
  expect(() => validateNode(lowerWins, [])).not.toThrow();
});
