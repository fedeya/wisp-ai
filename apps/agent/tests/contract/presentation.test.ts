import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { replyPresentation } from '../../src/contract/reply-presentation.ts';
import { referenceSchema } from '../../src/contract/rich-reference.ts';
import { nodeError, selectionValues, uiNode } from '../../src/contract/ui-schema.ts';
import { panelContent, panelInput } from '../../src/contract/panels.ts';
import type { UINode } from '../../src/contract/ui-schema.ts';

const present = (input: unknown) => Schema.decodeUnknownExit(replyPresentation)(input);
const node = (input: unknown): UINode => Schema.decodeUnknownSync(uiNode)(input);

const card = { id: 'root', kind: 'card', title: 'Gear' };
const spell = { kind: 'spell', id: 116, label: 'Frostbolt' };

it('presentations fill their defaults and drop unknown keys, as zod’s objects did', () => {
  expect(present({ nodes: [{ ...card, color: 'red' }], extra: 1 })).toEqual(
    Exit.succeed({ nodes: [card], references: {} }),
  );
  expect(present({ references: { frost: { ...spell, icon: 'x' } } })).toEqual(
    Exit.succeed({ nodes: [], references: { frost: spell } }),
  );
});

it('presentations give the refinement messages zod gave', () => {
  const messages: [unknown, string][] = [
    [{}, 'Supply a panel or verified references.'],
    [{ nodes: [card, card] }, 'Duplicate component ID.'],
    [{ nodes: [{ ...card, parent: 'missing' }] }, 'Declare parents before children.'],
    [{ nodes: [{ id: 'r', kind: 'reference', reference: 'missing' }] }, 'Declare the component'],
    [{ nodes: [{ ...card, id: 'x', parent: 'x' }] }, 'Declare parents before children.'],
    [
      { nodes: [{ id: 's', kind: 'slider', label: 'x', value: 2, min: 5, max: 1, step: 1 }] },
      'Invalid slider',
    ],
    [
      {
        nodes: [
          {
            id: 's',
            kind: 'select',
            label: 'x',
            value: 'c',
            options: [{ value: 'a', label: 'A' }],
          },
        ],
      },
      'Invalid selection',
    ],
    [
      {
        nodes: [
          {
            id: 't',
            kind: 'table',
            columns: [{ label: 'A' }, { label: 'B' }],
            rows: [['a', 'b', 'c']],
          },
        ],
      },
      'Table rows must match the columns',
    ],
  ];
  for (const [input, message] of messages) {
    expect(String(present(input)), message).toContain(message);
  }
});

it('references reject bad keys and inconsistent payloads', () => {
  for (const key of ['__proto__', 'constructor', '1st', 'a b', 'x'.repeat(65)]) {
    expect(Exit.isFailure(present({ references: { [key]: spell } })), key).toBe(true);
  }
  const reference = Schema.decodeUnknownExit(referenceSchema);
  expect(Exit.isSuccess(reference({ ...spell, payload: 'spell:116:0' }))).toBe(true);
  for (const input of [
    { ...spell, payload: 'item:116' },
    { ...spell, label: 'Frost|bolt' },
    { ...spell, label: 'See [[ref:x]]' },
    { kind: 'map', mapId: 1411, label: 'Durotar', x: 50 },
    { kind: 'macro', label: 'Macro', name: 'é'.repeat(9) },
    { kind: 'unit', label: 'Hogger', guid: 'Cr' },
  ]) {
    expect(Exit.isFailure(reference(input)), JSON.stringify(input)).toBe(true);
  }
});

it('a node error names why the node cannot join the others, without throwing', () => {
  const items = [
    { id: 'a', label: 'A', value: 1 },
    { id: 'b', label: 'B', value: 2 },
  ];
  const comparison = node({ id: 'c', kind: 'comparison', items, winner: 'b' });
  expect(nodeError(comparison, [])).toBeUndefined();
  const unknownWinner = node({ id: 'c', kind: 'comparison', items, winner: 'z' });
  expect(nodeError(unknownWinner, [])).toBe('Invalid comparison item reference');
  const text = node({ id: 't', parent: 'c', kind: 'text', text: 'x' });
  expect(nodeError(text, [comparison])).toBe('Invalid UI parent');
  const nested = Array.from({ length: 6 }, (_, i) =>
    node({ id: 'n' + i, kind: 'card', ...(i ? { parent: 'n' + (i - 1) } : {}) }),
  );
  const deepest = node({ id: 'n6', kind: 'card', parent: 'n5' });
  expect(nodeError(deepest, nested)).toBe('UI nesting limit');
});

it('selection values read each control, or nothing when one is invalid', () => {
  const controls = [
    node({ id: 'on', kind: 'toggle', label: 'On', value: false }),
    node({
      id: 'pick',
      kind: 'select',
      label: 'Pick',
      value: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }),
    node({ id: 'level', kind: 'slider', label: 'Level', value: 5, min: 1, max: 10, step: 1 }),
    node(card),
  ];
  expect(selectionValues(controls, { on: true, pick: 'b', other: 1 })).toEqual({
    on: true,
    pick: 'b',
    level: 5,
  });
  expect(selectionValues(controls, null)).toEqual({ on: false, pick: 'a', level: 5 });
  for (const input of [{ on: 'yes' }, { pick: 'c' }, { level: 11 }, { level: Number.NaN }]) {
    expect(selectionValues(controls, input), JSON.stringify(input)).toBeUndefined();
  }
});

it('panels keep their own rules: ask buttons, bound stat nodes and binding IDs', () => {
  const stat = { id: 'count', parent: 'root', kind: 'stat', label: 'Cloth', value: '0' };
  const panel = { id: 'cloth', title: 'Cloth', ui: [card, stat] };
  const save = (input: object) =>
    Schema.decodeUnknownExit(panelInput)({ operation: 'save', panel: { ...panel, ...input } });
  expect(Schema.decodeUnknownExit(panelContent)(panel)).toEqual(
    Exit.succeed({ ...panel, references: {}, bindings: [] }),
  );
  const messages: [object, string][] = [
    [{ bindings: [{ nodeId: 'count', source: 'item_count' }] }, 'itemId is required'],
    [{ bindings: [{ nodeId: 'count', source: 'quest_completed' }] }, 'questId is required'],
    [{ bindings: [{ nodeId: 'root', source: 'money' }] }, 'Bind data only to stat/progress nodes'],
    [
      {
        bindings: [
          { nodeId: 'count', source: 'money' },
          { nodeId: 'count', source: 'level' },
        ],
      },
      'Duplicate data binding',
    ],
    [{ ui: [card, { ...stat, parent: 'missing' }] }, 'Missing parent'],
    [
      {
        ui: [
          {
            id: 'b',
            kind: 'button',
            label: 'Apply',
            action: { kind: 'apply_settings', transactionId: 't' },
          },
        ],
      },
      'Persistent panel buttons must send follow-up questions',
    ],
  ];
  for (const [input, message] of messages) {
    expect(String(save(input)), message).toContain(message);
  }
});
