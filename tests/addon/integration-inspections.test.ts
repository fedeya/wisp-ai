import { expect, it } from '@effect/vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Effect, Schema } from 'effect';
import { inspectionResults } from '@wisp/agent/game-access';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = new URL('../../addon/WispAI/', import.meta.url);

/** What the addon reports and answers, as the bridge receives it from the game. */
const addonReply = Schema.Struct({
  report: Schema.Unknown,
  inspections: Schema.Struct({
    questie_quest: inspectionResults.questie_quest,
    questie_chain: inspectionResults.questie_chain,
    object_locations: inspectionResults.object_locations,
    stored_item: inspectionResults.stored_item,
    item_prices: inspectionResults.item_prices,
  }),
});

// Synthetic public-API fixtures run through the real Lua adapters, never player data.
function inspectAddon(): unknown {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(`ns={Core = {},
Chat = {},
Transport = {},
Character = {},
Actions = {},
Integrations = {},
ChatHistory = {},
Settings = {},
UI = {},
Inline = {},
Panels = {},
Advice = {}}; function time()return 123 end; function GetRealmName()return 'FixtureRealm'end; function UnitFactionGroup()return'Horde'end
    C_AddOns={GetAddOnMetadata=function()return'fixture'end}
    C_Map={GetBestMapForUnit=function()return 1454 end,GetMapInfo=function(id)if id==1454 then return{name='Orgrimmar'}end end,GetAreaInfo=function()return'Orgrimmar'end}
    local quests={ [600001]={name='Fixture quest',requiredLevel=10,preQuestGroup={600002},objectives={object={{99,'Fixture chest'}}}}, [600002]={name='Fixture prerequisite',childQuests={600001}} }
    LibQuestieDB={flavor={expansion='Forever'},RequireContract=function(v)return v==4 end,EraToForever=function(_,x,y)return x,y end,
      Quest={Exists=function(id)return quests[id]~=nil end,Get=function(id,key)return quests[id]and quests[id][key]end},
      Object={Exists=function(id)return id==99 end,Get=function(id,key)if key=='name'then return'Fixture chest'elseif key=='spawns'then return{[1637]={{45,55}}}end end}}
    Syndicator={API={IsReady=function()return true end,GetInventoryInfoByItemID=function(id,realm,faction)assert(id==123 and realm and faction);return{characters={{character='FixtureAlt',realmNormalized='FixtureRealm',bags=2,bank=4,mail=1,equipped=0,auctions=3}},guilds={}}end}}
    Auctionator={API={v1={GetAuctionPriceByItemID=function(_,id)if id==123 then return 450 end end,GetAuctionAgeByItemID=function(_,id)if id==123 then return 3 end end}}}
  `);
  for (const file of [
    'Namespace.lua',
    'Shared/Numbers.lua',
    'Shared/Text.lua',
    'Integrations/Integrations.lua',
    'Integrations/Questie.lua',
    'Integrations/Syndicator.lua',
    'Integrations/Auctionator.lua',
    'Integrations/PolestarGuides.lua',
    'Integrations/Polestar.lua',
  ]) {
    run(`assert(load(${JSON.stringify(readFileSync(new URL(file, addon), 'utf8'))}))('WispAI',ns)`);
  }
  run(`RESULT={ report=ns.Integrations.IntegrationReport(), inspections={
    questie_quest=ns.Integrations.InspectIntegration({kind='questie_quest',args={questId=600001}}),
    questie_chain=ns.Integrations.InspectIntegration({kind='questie_chain',args={questId=600001,direction='both',maxDepth=2,limit=15}}),
    object_locations=ns.Integrations.InspectIntegration({kind='object_locations',args={objectId=99,mapId=1454}}),
    stored_item=ns.Integrations.InspectIntegration({kind='stored_item',args={itemId=123,includeGuild=false,limit=20}}),
    item_prices=ns.Integrations.InspectIntegration({kind='item_prices',args={itemIds={123,999}}})
  } }`);
  function value(index: number): unknown {
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TSTRING) {
      return to_jsstring(lua.lua_tolstring(L, index));
    }
    if (type === lua.LUA_TNUMBER) {
      return lua.lua_tonumber(L, index);
    }
    if (type === lua.LUA_TBOOLEAN) {
      return !!lua.lua_toboolean(L, index);
    }
    if (type !== lua.LUA_TTABLE) {
      return null;
    }
    const absolute = lua.lua_absindex(L, index),
      rows: [string | number, unknown][] = [];
    lua.lua_pushnil(L);
    while (lua.lua_next(L, absolute)) {
      const key = value(-2);
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw Error('Unexpected Lua table key.');
      }
      rows.push([key, value(-1)]);
      lua.lua_pop(L, 1);
    }
    // WoW SerializeJSON also represents an empty Lua table as an array.
    if (rows.every(([key]) => typeof key === 'number' && key >= 1 && key <= rows.length)) {
      return rows.sort(([a], [b]) => Number(a) - Number(b)).map(([, child]) => child);
    }
    return Object.fromEntries(rows);
  }
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return value(-1);
}

// The Busted specs check each adapter in Lua; this checks that what the adapters
// answer is what the agent's inspection schemas accept.
it.effect('the real integration adapters answer in the shape the agent decodes', () =>
  Effect.gen(function* () {
    const { report, inspections } = yield* Schema.decodeUnknownEffect(addonReply)(inspectAddon());
    expect(report).toMatchObject({
      questie: { quests: true, objects: true },
      syndicator: { status: 'ready' },
      auctionator: { status: 'ready' },
      polestar: { status: 'missing', guides: false },
    });
    for (const inspection of Object.values(inspections)) {
      expect(inspection.status).toBe('available');
    }
    expect(inspections.stored_item).toMatchObject({ data: { totalCached: 10 } });
    expect(inspections.item_prices).toMatchObject({
      data: {
        prices: [
          { itemId: 123, status: 'available', unitPriceCopper: 450, ageDays: 3, ageKnown: true },
          { itemId: 999, status: 'unknown', ageKnown: false },
        ],
      },
    });
  }),
);
