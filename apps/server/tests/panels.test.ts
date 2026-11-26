import { test } from 'vitest';
import { it } from '@effect/vitest';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { PanelStore } from '../src/panels/panel-store.ts';
import { reopen, testStorage } from './storage-fixture.ts';
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
it.live(
  'persistent panels isolate characters, survive restart and update by ID without duplication',
  () =>
    Effect.gen(function* () {
      const store = yield* PanelStore;
      yield* store.mutate('mage', { operation: 'save', panel: panelContent.parse(example) });
      yield* store.mutate('warrior', {
        operation: 'save',
        panel: panelContent.parse({ ...example, title: 'Other character' }),
      });
      yield* store.mutate('mage', {
        operation: 'save',
        panel: panelContent.parse({ ...example, title: 'Updated materials' }),
      });
      yield* reopen(
        Effect.gen(function* () {
          const next = yield* PanelStore;
          const mage = yield* next.list('mage');
          assert.equal(mage.length, 1);
          assert.equal(mage[0].title, 'Updated materials');
          assert.equal((yield* next.list('warrior'))[0].title, 'Other character');
          yield* next.mutate('mage', { operation: 'remove', id: 'materials' });
          assert.equal((yield* next.list('warrior')).length, 1);
        }),
      );
      const reopened = yield* reopen(
        Effect.gen(function* () {
          return yield* (yield* PanelStore).all();
        }),
      );
      assert.equal(reopened.length, 1);
    }).pipe(Effect.provide(testStorage())),
);
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
