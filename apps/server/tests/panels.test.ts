import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope, promised } from './database-fixture.ts';
import { makePanelStore } from '../src/panels/panel-store.ts';
import { panelContent } from '@wisp/agent/contract/panels';
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
  const scope = databaseScope();
  try {
    const file = path.join(root, 'wisp.sqlite'),
      store = promised(makePanelStore(await scope.open(file)));
    await store.mutate('mage', { operation: 'save', panel: panelContent.parse(example) });
    await store.mutate('warrior', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Other character' }),
    });
    await store.mutate('mage', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Updated materials' }),
    });
    const next = promised(makePanelStore(await scope.open(file)));
    assert.equal((await next.list('mage')).length, 1);
    assert.equal((await next.list('mage'))[0].title, 'Updated materials');
    assert.equal((await next.list('warrior'))[0].title, 'Other character');
    await next.mutate('mage', { operation: 'remove', id: 'materials' });
    assert.equal((await next.list('warrior')).length, 1);
    const reopened = promised(makePanelStore(await scope.open(file)));
    assert.equal((await reopened.all()).length, 1);
  } finally {
    await scope.close();
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
