import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope } from './database-fixture.ts';
import { panelContent } from '@wisp/agent/contract/panels';
import { panels } from '@wisp/db/schema';
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
      store = await scope.panels(scope.open(file));
    await store.update('mage', { operation: 'save', panel: panelContent.parse(example) });
    await store.update('warrior', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Other character' }),
    });
    await store.update('mage', {
      operation: 'save',
      panel: panelContent.parse({ ...example, id: 'supplies' }),
    });
    await store.update('mage', {
      operation: 'save',
      panel: panelContent.parse({ ...example, title: 'Updated materials' }),
    });
    const next = await scope.panels(scope.open(file));
    const mage = await next.list('mage');
    assert.deepEqual(
      mage.map((panel) => panel.id),
      ['supplies', 'materials'],
    );
    assert.equal(mage[1].title, 'Updated materials');
    assert.equal((await next.list('warrior'))[0].title, 'Other character');
    await next.update('mage', { operation: 'remove', id: 'materials' });
    assert.equal((await store.list('warrior')).length, 1);
    assert.deepEqual(
      (await store.list('mage')).map((panel) => panel.id),
      ['supplies'],
    );
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('concurrent writers cannot both take the last panel slot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-panels-'));
  const scope = databaseScope();
  try {
    const file = path.join(root, 'wisp.sqlite');
    const first = await scope.panels(scope.open(file));
    const second = await scope.panels(scope.open(file));
    const save = (store: typeof first, id: string) =>
      store.update('mage', { operation: 'save', panel: panelContent.parse({ ...example, id }) });
    for (let i = 0; i < 11; i++) await save(first, `panel-${i}`);

    const results = await Promise.allSettled([save(first, 'last-a'), save(second, 'last-b')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.match(String(rejected?.reason), /Keep at most 12 panels per character/);
    assert.equal((await first.list('mage')).length, 12);
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('unreadable panels do not hide valid panels and still count toward the quota', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-panels-'));
  const scope = databaseScope();
  try {
    const database = scope.open(path.join(root, 'wisp.sqlite'));
    const store = await scope.panels(database);
    const save = (id: string) =>
      store.update('mage', { operation: 'save', panel: panelContent.parse({ ...example, id }) });
    await save('materials');
    await database.transaction((db) =>
      db
        .insert(panels)
        .values(
          Array.from({ length: 11 }, (_, index) => ({
            characterKey: 'mage',
            id: `old-${index}`,
            title: 'Old panel',
            sortIndex: index + 1,
            updatedAt: 0,
            content: JSON.stringify({ formerKey: 'old-mage', ui: [] }),
          })),
        )
        .run(),
    );

    assert.deepEqual(
      (await store.list('mage')).map((panel) => panel.id),
      ['materials'],
    );
    await assert.rejects(save('extra'), /Keep at most 12 panels per character/);
    const repaired = await save('old-0');
    assert.deepEqual(
      repaired.map(({ id, formerKey }) => [id, formerKey]),
      [
        ['materials', undefined],
        ['old-0', 'old-mage'],
      ],
    );
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
