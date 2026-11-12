import { test, expect } from 'vitest';
import { exportTemplate, parseTemplate, instantiateTemplate } from '../src/panel-template.ts';

export const source = {
  id: 'AlicePrivate',
  title: 'Consumables',
  characterKey: 'Alice Realm',
  updatedAt: 123,
  ui: [
    { id: 'AliceRoot', kind: 'card', title: 'Bags only' },
    ...[2589, 2592, 4306].map((id, i) => ({
      id: `Alice${id}`,
      parent: 'AliceRoot',
      kind: 'stat',
      label: ['Linen Cloth', 'Wool Cloth', 'Silk Cloth'][i],
      value: '987 private progress',
      detail: 'runtime',
    })),
  ],
  references: {},
  bindings: [2589, 2592, 4306].map((itemId) => ({
    nodeId: `Alice${itemId}`,
    source: 'item_count',
    itemId,
    target: 20,
  })),
};
test('export is a neutral definition; recipient initializes unknown and retains layout/goals', () => {
  const text = JSON.stringify(exportTemplate(source));
  expect(text).not.toMatch(/Alice|987|runtime|updatedAt|characterKey|value/);
  const template = parseTemplate(text);
  const panel = instantiateTemplate(template, 'fresh');
  expect(panel.bindings.map((b) => b.target)).toEqual([20, 20, 20]);
  expect(panel.ui[1]).toMatchObject({ parent: 'n1', value: 'Loading' });
});
test('rejects executable, incompatible, malformed and oversized definitions', () => {
  const template = exportTemplate(source);
  for (const mutate of [
    (t: any) => {
      t.version = 2;
    },
    (t: any) => {
      t.game = 'retail';
    },
    (t: any) => {
      t.ui[1].parent = 'absent';
    },
    (t: any) => {
      t.ui[1].id = t.ui[0].id;
    },
    (t: any) => {
      t.bindings[0].target = 1.5;
    },
    (t: any) => {
      t.ui[1].kind = 'button';
      t.ui[1].action = { kind: 'ask', prompt: 'hello' };
    },
    (t: any) => {
      t.title = 'https://example.com';
    },
    (t: any) => {
      t.constructor = {};
    },
  ]) {
    const copy = structuredClone(template);
    mutate(copy);
    expect(() => parseTemplate(JSON.stringify(copy))).toThrow();
  }
  expect(() => parseTemplate(' '.repeat(28001))).toThrow();
  expect(() => parseTemplate('é'.repeat(14001))).toThrow(/too large/);
  expect(() =>
    exportTemplate({
      ...source,
      references: {
        cloth: { kind: 'item', id: 2589, label: 'Linen Cloth', source: 'Forever fixture' },
      },
    }),
  ).toThrow(/reference catalogs are not supported/);
  expect(() =>
    exportTemplate({
      ...source,
      ui: [
        ...source.ui,
        { id: 'ask', kind: 'button', label: 'Ask', action: { kind: 'ask', prompt: 'hello' } },
      ],
    }),
  ).toThrow();
});
