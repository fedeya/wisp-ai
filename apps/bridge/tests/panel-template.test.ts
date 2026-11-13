import { test, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope } from './database-fixture.ts';
import { PanelStore } from '../src/panels.ts';
import { createDesktopHandler } from '../src/desktop-handler.ts';
import { panelContent } from '@wisp/protocol/panels';
import { readPanels } from '../src/db/product-store.ts';
import { parseTemplate, TEMPLATE_BYTES } from '@wisp/protocol/panel-template';

const A = JSON.stringify(['WoW Forever', 'Synthetic realm', 'A']);
const B = JSON.stringify(['WoW Forever', 'Synthetic realm', 'B']);
const incompatible = JSON.stringify(['WoW Retail', 'Synthetic realm', 'C']);
test('near-budget desktop export text roundtrips unchanged through parser and recipient SQLite import', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'template-budget-'));
  const scope = databaseScope();
  const forbidden = vi.fn(() => {
    throw Error('No model/tool/game action allowed');
  });
  try {
    const file = path.join(root, 'wisp.sqlite');
    const store = new PanelStore(scope.open(file));
    await store.load();
    const source = panelContent.parse({
      id: 'PrivateSource',
      title: 'T'.repeat(100),
      references: {},
      ui: [
        {
          id: 'PrivateCount',
          kind: 'stat',
          label: 'Cloth',
          value: '987',
          detail: 'private runtime',
        },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `PrivateText${i}`,
          kind: 'text',
          text: 'x'.repeat(3000),
        })),
      ],
      bindings: [{ nodeId: 'PrivateCount', source: 'item_count', itemId: 2589, target: 20 }],
    });
    await store.mutate(A, { operation: 'save', panel: source });
    const handler = createDesktopHandler({
      panelStore: store,
      getChats: () => [{ characterKey: B }],
      currentCharacterKey: () => undefined,
      changed: vi.fn(),
      sendPanelCommand: forbidden,
      accountOperation: forbidden,
      readSimulationCharacter: forbidden,
      openRoutine: forbidden,
      updateModel: forbidden,
      setCapability: forbidden,
      refreshMcpCatalog: forbidden,
      requestStop: forbidden,
    } as unknown as Parameters<typeof createDesktopHandler>[0]);
    const exported = (await handler('POST', '/panels/export', {
      characterKey: A,
      id: source.id,
    })) as { template: string };
    const definition = JSON.parse(exported.template);
    const bytes = {
      sourceUTF8: Buffer.byteLength(JSON.stringify(source), 'utf8'),
      compactUTF8: Buffer.byteLength(JSON.stringify(definition), 'utf8'),
      indentedUTF8: Buffer.byteLength(JSON.stringify(definition, null, 2), 'utf8'),
      emittedUTF8: Buffer.byteLength(exported.template, 'utf8'),
      limit: TEMPLATE_BYTES,
    };
    console.info('Export wire budget:', JSON.stringify(bytes));
    expect(bytes.sourceUTF8).toBeLessThanOrEqual(TEMPLATE_BYTES);
    expect(bytes.compactUTF8).toBeGreaterThan(TEMPLATE_BYTES - 500);
    expect(bytes.compactUTF8).toBeLessThanOrEqual(TEMPLATE_BYTES);
    expect(bytes.indentedUTF8).toBeGreaterThan(TEMPLATE_BYTES);
    expect(bytes.emittedUTF8).toBeLessThanOrEqual(TEMPLATE_BYTES);
    const preview = parseTemplate(exported.template);
    expect(exported.template).toBe(JSON.stringify(preview));
    expect(exported.template).not.toMatch(
      /Private|Synthetic|987|runtime|value|characterKey|updatedAt/,
    );
    expect(preview.title).toBe(source.title);
    expect(preview.ui).toHaveLength(10);
    expect(preview.ui.every((n) => n.parent === undefined)).toBe(true);
    expect(preview.ui.slice(1).map((n) => (n.kind === 'text' ? n.text : ''))).toEqual(
      source.ui.slice(1).map((n) => (n.kind === 'text' ? n.text : '')),
    );
    await handler('POST', '/panels/import', {
      characterKey: B,
      template: exported.template,
      confirmed: true,
    });
    const restarted = new PanelStore(scope.open(file));
    await restarted.load();
    const saved = restarted.list(B)[0];
    expect(saved.title).toBe(source.title);
    expect(saved.ui[0]).toEqual({ id: 'n1', kind: 'stat', label: 'Cloth', value: 'Loading' });
    expect(saved.ui.slice(1)).toEqual(preview.ui.slice(1));
    expect(saved.bindings).toEqual([
      { nodeId: 'n1', source: 'item_count', itemId: 2589, target: 20 },
    ]);
    expect(restarted.list(A)).toHaveLength(1);
    const before = JSON.stringify(readPanels(store.database.orm));
    for (const oversized of [
      ' '.repeat(TEMPLATE_BYTES - bytes.emittedUTF8 + 1) + exported.template,
      JSON.stringify({
        ...preview,
        ui: [...preview.ui, { id: 'n11', kind: 'text', text: 'x'.repeat(1000) }],
      }),
    ]) {
      expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(TEMPLATE_BYTES);
      expect(() => parseTemplate(oversized)).toThrow(/too large/);
      await expect(
        handler('POST', '/panels/import', {
          characterKey: B,
          template: oversized,
          confirmed: true,
        }),
      ).rejects.toThrow();
      expect(JSON.stringify(readPanels(store.database.orm))).toBe(before);
    }
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('desktop export → explicit recipient import uses SQLite, fresh IDs, restart and no actions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'template-'));
  const scope = databaseScope();
  const forbidden = vi.fn(() => {
    throw Error('No model/tool/game action allowed');
  });
  const changed = vi.fn();
  const file = path.join(root, 'wisp.sqlite');
  try {
    const store = new PanelStore(scope.open(file));
    await store.load();
    await store.mutate(A, {
      operation: 'save',
      panel: panelContent.parse({
        id: 'privateA',
        title: 'Consumables',
        references: {},
        ui: [
          { id: 'privateRoot', kind: 'card', title: 'Bags only' },
          ...[2589, 2592, 4306].map((itemId, i) => ({
            id: `private${i}`,
            parent: 'privateRoot',
            kind: 'stat',
            label: ['Linen Cloth', 'Wool Cloth', 'Silk Cloth'][i],
            value: '987',
            detail: 'A runtime',
          })),
        ],
        bindings: [2589, 2592, 4306].map((itemId, i) => ({
          nodeId: `private${i}`,
          source: 'item_count',
          itemId,
          target: 20,
        })),
      }),
    });
    const handler = createDesktopHandler({
      panelStore: store,
      getChats: () => [{ characterKey: B }, { characterKey: incompatible }],
      currentCharacterKey: () => undefined,
      changed,
      sendPanelCommand: forbidden,
      accountOperation: forbidden,
      readSimulationCharacter: forbidden,
      openRoutine: forbidden,
      updateModel: forbidden,
      setCapability: forbidden,
      refreshMcpCatalog: forbidden,
      requestStop: forbidden,
    } as unknown as Parameters<typeof createDesktopHandler>[0]);
    const exported = (await handler('POST', '/panels/export', {
      characterKey: A,
      id: 'privateA',
    })) as { template: string };
    expect(exported.template).not.toMatch(/private|Synthetic|987|runtime/);
    const before = JSON.stringify(readPanels(store.database.orm));
    const memoryBefore = JSON.stringify(store.panels);
    const definition = JSON.parse(exported.template);
    const invalidTemplates = [
      '{}',
      ' '.repeat(28001),
      JSON.stringify({ ...definition, version: 2 }),
      JSON.stringify({ ...definition, game: 'classic' }),
      JSON.stringify({
        ...definition,
        references: { privateRef: { kind: 'item', id: 2589, label: 'Cloth' } },
      }),
      JSON.stringify({
        ...definition,
        ui: [
          ...definition.ui,
          {
            id: 'n9',
            kind: 'button',
            label: 'Ask',
            action: { kind: 'ask', prompt: 'Do something' },
          },
        ],
      }),
      JSON.stringify({
        ...definition,
        bindings: [{ ...definition.bindings[0], nodeId: 'n99' }, ...definition.bindings.slice(1)],
      }),
      JSON.stringify({
        ...definition,
        ui: definition.ui.map((n: Record<string, unknown>, i: number) =>
          i === 1 ? { ...n, parent: 'n99' } : n,
        ),
      }),
      ...[0, -1, 1.5, null].map((target) =>
        JSON.stringify({
          ...definition,
          bindings: [{ ...definition.bindings[0], target }, ...definition.bindings.slice(1)],
        }),
      ),
    ];
    for (const raw of [
      {
        characterKey: JSON.stringify(['WoW Forever', 'Synthetic realm', 'Forged']),
        template: exported.template,
        confirmed: true,
      },
      { characterKey: incompatible, template: exported.template, confirmed: true },
      { characterKey: B, template: exported.template, confirmed: false },
      ...invalidTemplates.map((template) => ({ characterKey: B, template, confirmed: true })),
    ]) {
      await expect(handler('POST', '/panels/import', raw)).rejects.toThrow();
      expect(JSON.stringify(readPanels(store.database.orm))).toBe(before);
      expect(JSON.stringify(store.panels)).toBe(memoryBefore);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    const edited = JSON.parse(exported.template);
    edited.bindings[1].target = 40;
    for (let i = 0; i < 2; i++) {
      await handler('POST', '/panels/import', {
        characterKey: B,
        template: JSON.stringify(edited),
        confirmed: true,
      });
    }
    expect(store.list(B)).toHaveLength(2);
    expect(new Set(store.list(B).map((p) => p.id)).size).toBe(2);
    expect(store.list(B)[0].ui[1]).toMatchObject({ value: 'Loading', parent: 'n1' });
    expect(store.list(B)[0].bindings.map((b) => b.target)).toEqual([20, 40, 20]);
    const restarted = new PanelStore(scope.open(file));
    await restarted.load();
    expect(restarted.list(A)).toHaveLength(1);
    expect(restarted.list(B)).toHaveLength(2);
    for (let i = 2; i < 12; i++) {
      await handler('POST', '/panels/import', {
        characterKey: B,
        template: exported.template,
        confirmed: true,
      });
    }
    const atLimit = JSON.stringify(readPanels(store.database.orm));
    await expect(
      handler('POST', '/panels/import', {
        characterKey: B,
        template: exported.template,
        confirmed: true,
      }),
    ).rejects.toThrow(/12/);
    expect(store.list(B)).toHaveLength(12);
    expect(JSON.stringify(readPanels(store.database.orm))).toBe(atLimit);
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
