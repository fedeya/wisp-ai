import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PanelStore } from '../../apps/bridge/src/panels.ts';
import { createDesktopHandler } from '../../apps/bridge/src/desktop-handler.ts';
import { databaseScope } from '../../apps/bridge/tests/database-fixture.ts';
import { panelContent } from '@wisp/protocol/panels';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
function literal(value: unknown): string {
  if (value === undefined || value === null) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `{${value.map(literal).join(',')}}`;
  return `{${Object.entries(value)
    .map(([k, v]) => `[${literal(k)}]=${literal(v)}`)
    .join(',')}}`;
}
test('two SQLite installations: actual desktop import reaches native BoundPanel with B counts and unresolved unknown, never sender progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'template-native-'));
  const scope = databaseScope();
  const A = JSON.stringify(['WoW Forever', 'Synthetic', 'A']);
  const B = JSON.stringify(['WoW Forever', 'Synthetic', 'B']);
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  try {
    const a = new PanelStore(scope.open(path.join(root, 'a.sqlite')));
    const b = new PanelStore(scope.open(path.join(root, 'b.sqlite')));
    await a.load();
    await b.load();
    await a.mutate(A, {
      operation: 'save',
      panel: panelContent.parse({
        id: 'privateA',
        title: 'Consumables',
        references: {},
        ui: [
          { id: 'privateRoot', kind: 'card', title: 'Bags only' },
          ...[2589, 2592, 4306].map((id, i) => ({
            id: `private${i}`,
            parent: 'privateRoot',
            kind: i === 2 ? 'progress' : 'stat',
            label: ['Linen Cloth', 'Wool Cloth', 'Silk Cloth'][i],
            value: i === 2 ? 0.95 : '987',
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
    let actions = 0;
    const handler = (store: PanelStore, key: string) =>
      createDesktopHandler({
        panelStore: store,
        getChats: () => [{ characterKey: key }],
        currentCharacterKey: () => undefined,
        changed: () => {},
        sendPanelCommand: () => {
          actions++;
        },
      } as unknown as Parameters<typeof createDesktopHandler>[0]);
    const exported = (await handler(a, A)('POST', '/panels/export', {
      characterKey: A,
      id: 'privateA',
    })) as { template: string };
    expect(exported.template).not.toMatch(/Synthetic|private|987|0.95/);
    await handler(b, B)('POST', '/panels/import', {
      characterKey: B,
      template: exported.template,
      confirmed: true,
    });
    expect(b.list(A)).toHaveLength(0);
    expect(b.list(B)).toHaveLength(1);
    expect(actions).toBe(0);
    const imported = b.list(B)[0];
    expect(imported).toMatchObject({ initiallyHidden: true, requireItemData: true });
    run(
      'ns = { Panels = {}, db = {} }; C_Item = {}; localNames = { [2589] = "Linen Cloth", [2592] = "Wool Cloth" }; counts = { [2589] = 3, [2592] = 0, [4306] = 999 }; C_Item.GetItemInfo = function(id) return localNames[id] end; C_Item.GetItemCount = function(id, bank) assert(bank == false); return counts[id] end',
    );
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/Panels/Panels.lua', 'utf8'))}))('WispAI', ns)`,
    );
    run(`panel = ${literal(imported)}; view = ns.Panels.BoundPanel(panel)
      assert(view.ui[2].value == '3 / 20')
      assert(view.ui[3].value == '0 / 20', 'zero must stay known')
      assert(view.ui[4].unavailable == true, 'uncached item must not become zero/known from count alone')
      assert(panel.ui[2].value == 'Loading', 'canonical panel must remain unknown')
      localNames[4306] = 'Silk Cloth'; counts[4306] = 5
      assert(ns.Panels.BoundPanel(panel).ui[4].value == 0.25)
      C_Item.GetItemCount = nil
      assert(ns.Panels.BoundPanel(panel).ui[2].value == 'Unavailable')
    `);
    run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
    run(`
      ns.UI = { RichSignature = function() return 'fixture' end, RenderRichUI = function() return 100, false end }
      ns.Markdown = { Cache = { revision = 0 } }
      UnitName = function() return 'B' end
      GetRealmName = function() return 'Synthetic' end
      C_EncodingUtil = { DeserializeJSON = function() return { 'WoW Forever', 'Synthetic', 'B' } end }
      ns.Panels.ReceivePanels({ panel })
      local window
      for _, widget in ipairs(UI_TEST.widgets) do
        if widget.title and type(widget.title) == 'table' and widget.title:GetText() == 'Consumables' then window = widget end
      end
      assert(window and not window:IsShown(), 'import must not auto-show')
      ns.Panels.ReceivePanels({ panel }, { seq = 1, id = panel.id, characterKey = panel.characterKey, action = 'show' })
      assert(window:IsShown(), 'explicit show still works')
      ns.Panels.ReceivePanels({})
      assert(not window:IsShown(), 'foreign character snapshot must hide panel')
    `);
  } finally {
    lua.lua_close(L);
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
