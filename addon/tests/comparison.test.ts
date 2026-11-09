import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { uiNode, validateNode } from '@wisp/protocol/ui-schema';
import { ReplyStream } from '@wisp/bridge/reply-stream';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
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

test('native comparison resizes, updates winners, handles zero results and reuses widgets', () => {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(state, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(state, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run('C = {}; host = CreateFrame("Frame"); C.LinkWidget = function(w) w.linked = true end');
  for (const file of ['EmojiData.lua', 'Emoji.lua', 'MessageFormat.lua']) {
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + file, 'utf8'))}))('WispAI', C)`,
    );
  }
  run(
    `assert(load(${JSON.stringify(readFileSync('addon/WispAI/RichUI.lua', 'utf8'))}))('WispAI', C)`,
  );
  run(`
    local node = { id='sim', kind='comparison', title='Rotaciones', unit='DPS',
      winner='mixed', winnerLabel='Mejor DPS', baseline='frost', items={
        {id='mixed',label='Misiles + Explosión',value=25.28,detail='Canales completos'},
        {id='frost',label='[[ref:frost]]',value=20.65},
        {id='zero',label='Sin daño',value=0},
      }}
    local message = {references={frost={kind='spell',id=205,label='Descarga de Escarcha'}},
      ui={node, {id='stat',kind='stat',label='DPS',value='25.28',detail='Experimental'}}}
    C.RenderRichUI(host, {}, message, 600)
    local card = host.widgets.sim
    local first, second = card.entries[1], card.entries[2]
    assert(first.badge:GetText() == 'Mejor DPS' and not second.badge:IsShown())
    assert(first.metric:GetText() == '25.3 DPS')
    assert(first.delta:GetText():find('+22.4% vs. ', 1, true))
    assert(first.delta:GetText():find('|Hspell:205|h[Descarga de Escarcha]|h', 1, true))
    assert(second.metric:GetText():match('^20%.%d DPS$'))
    assert(first.bar:GetValue() == 1 and math.abs(second.bar:GetValue() - 20.65/25.28) < 0.0001)
    assert(card.entries[3].bar:GetValue() == 0)
    assert(node.items[1].value == 25.28 and node.items[2].value == 20.65, 'rounding is presentation only')
    node.precision = 2
    C.RenderRichUI(host, {}, message, 600)
    assert(first.metric:GetText() == '25.28 DPS')
    node.precision = nil
    assert(first.metric.point[5] == first.title.point[5], 'wide layout aligns numbers')
    assert(first.linked and second.linked, 'spell hyperlinks remain interactive')
    assert(second.title:GetText():find('|Hspell:205|h[Descarga de Escarcha]|h', 1, true))
    local stat = host.widgets.stat
    assert(stat.title:GetText() == 'DPS' and stat.metric:GetText() == '25.28')
    assert(stat.detail.point[5] < stat.metric.point[5] and stat.metric.point[5] < stat.title.point[5])
    local count = #UI_TEST.widgets
    node.items[1].label = string.rep('Nombre largo localizado ', 4)
    C.RenderRichUI(host, {}, message, 210)
    assert(#UI_TEST.widgets == count, 'snapshots and resize must reuse widgets')
    assert(first.metric.point[5] < first.title.point[5], 'narrow layout stacks values')
    assert(first.delta.point[5] < first.metric.point[5] - first.metric:GetStringHeight())
    assert(first.bar.point[5] < first.metric.point[5] - first.metric:GetStringHeight())
    assert(first.detail.point[5] < first.bar.point[5])
    assert(first:GetHeight() >= -first.detail.point[5] + first.detail:GetStringHeight())
    node.winner = 'frost'
    node.items[1].value = 0; node.items[2].value = 0
    node.items[3] = nil
    C.RenderRichUI(host, {}, message, 600)
    assert(not first.badge:IsShown() and second.badge:IsShown())
    assert(first.bar:GetValue() == 0 and second.bar:GetValue() == 0)
    assert(first.metric:GetText() == '0.0 DPS', 'zero baseline cannot produce a percentage')
    assert(not first.delta:IsShown())
    assert(not card.entries[3]:IsShown(), 'removed entries must disappear')
    node.winner = nil
    node.items[1].detail = nil
    message.ui[2].detail = nil
    C.RenderRichUI(host, {}, message, 300)
    assert(not first.badge:IsShown() and not second.badge:IsShown())
    assert(not first.detail:IsShown() and not stat.detail:IsShown())
  `);
});
