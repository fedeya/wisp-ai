import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PanelStore } from '@wisp/bridge/panels';
import { panelContent } from '@wisp/protocol/panels';
const example = {
  id: 'materials',
  title: 'Materials',
  ui: [
    { id: 'root', kind: 'card', title: 'Materials' },
    { id: 'count', parent: 'root', kind: 'stat', label: 'Cloth', value: 'Loading' },
  ],
  bindings: [{ nodeId: 'count', source: 'item_count', itemId: 2589, target: 10 }],
  references: {},
};
test('persistent panels isolate characters, survive restart and update by ID without duplication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-panels-'));
  try {
    const file = path.join(root, 'wisp.sqlite'),
      store = new PanelStore(file);
    await store.load();
    await store.mutate('mage', { operation: 'save', panel: panelContent.parse(example) });
    await store.mutate('warrior', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Other character' }),
    });
    await store.mutate('mage', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Updated materials' }),
    });
    const next = new PanelStore(file);
    await next.load();
    assert.equal(next.list('mage').length, 1);
    assert.equal(next.list('mage')[0].title, 'Updated materials');
    assert.equal(next.list('warrior')[0].title, 'Other character');
    await next.mutate('mage', { operation: 'remove', id: 'materials' });
    assert.equal(next.list('warrior').length, 1);
    const reopened = new PanelStore(file);
    await reopened.load();
    assert.equal(reopened.panels.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('panel schema validates parents, bindings, IDs and excludes stale settings actions', () => {
  assert.throws(() =>
    panelContent.parse({
      ...example,
      bindings: [{ nodeId: 'missing', source: 'item_count', itemId: 1 }],
    }),
  );
  assert.throws(() =>
    panelContent.parse({ ...example, bindings: [{ nodeId: 'count', source: 'item_count' }] }),
  );
  assert.throws(() =>
    panelContent.parse({
      ...example,
      ui: [
        {
          id: 'button',
          kind: 'button',
          label: 'Apply',
          action: { kind: 'apply_settings', transactionId: 'old' },
        },
      ],
    }),
  );
  assert.throws(() =>
    panelContent.parse({
      ...example,
      ui: [{ id: 'count', kind: 'stat', parent: 'missing', label: 'x', value: 'x' }],
    }),
  );
});
