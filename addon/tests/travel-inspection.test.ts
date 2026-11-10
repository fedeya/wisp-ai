import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  COMPRESSED,
  inflateMessage,
  MAX_ENCODED_BYTES,
  MAX_DECODED_BYTES,
} from '@wisp/protocol/mailbox';
const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
function fixture(code: string) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (text: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(text)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(`C={}; events={}; function time()return 123 end
    function GetTime()return 100 end
    function UnitName()return 'Fixture' end
    function CreateFrame()return {RegisterEvent=function()end,SetScript=function(_,_,fn)events[#events+1]=fn end}end
    function GetBindLocation()return 'Inn' end
    C_Item={GetItemCount=function(id,bank)assert(id==6948 and bank==false);return 1 end}
    C_Container={GetItemCooldown=function(id)assert(id==6948);return 0,0,1 end}
    FlightMapFrame={IsShown=function()return true end,GetMapID=function()return 42 end}
    C_TaxiMap={GetAllTaxiNodes=function(id)assert(id==42);return {
      {nodeID=1,name='Origin',state=0,slotIndex=1,position={x=.1,y=.2}},
      {nodeID=2,name='Destination',state=1,slotIndex=2,position={GetXY=function()return .3,.4 end}},
      {nodeID=3,name='Other',state=2,slotIndex=3},
      {nodeID=4,name='Unknown',state=99,slotIndex=4}}end,
      GetTaxiNodesForMap=function()error('not current-master evidence')end}
    function TakeTaxiNode()error('write')end
    function UseItemByName()error('write')end
    function UseContainerItem()error('write')end
    function CastSpellByID()error('write')end
  `);
  const modules = readFileSync('addon/WispAI/WispAI.toc', 'utf8')
    .split(/\r?\n/)
    .filter((file) => ['Locations.lua', 'Travel.lua', 'Character.lua'].includes(file));
  assert.ok(modules.indexOf('Travel.lua') > modules.indexOf('Locations.lua'));
  for (const file of modules) {
    const path = 'addon/WispAI/' + file;
    run(`assert(load(${JSON.stringify(readFileSync(path, 'utf8'))}))('WispAI',C)`);
  }
  run(code);
  const decode = (index: number): unknown => {
    const at = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, at)) {
      case lua.LUA_TNIL:
        return null;
      case lua.LUA_TBOOLEAN:
        return Boolean(lua.lua_toboolean(L, at));
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, at);
      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tolstring(L, at));
      case lua.LUA_TTABLE: {
        const entries: [string | number, unknown][] = [];
        lua.lua_pushnil(L);
        while (lua.lua_next(L, at)) {
          const key =
            lua.lua_type(L, -2) === lua.LUA_TNUMBER
              ? lua.lua_tonumber(L, -2)
              : to_jsstring(lua.lua_tolstring(L, -2));
          entries.push([key, decode(-1)]);
          lua.lua_pop(L, 1);
        }
        if (entries.length && entries.every(([key]) => typeof key === 'number')) {
          return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value);
        }
        return Object.fromEntries(entries);
      }
      default:
        throw Error('Non-JSON Lua value');
    }
  };
  lua.lua_getglobal(L, to_luastring('snapshot'));
  return JSON.stringify(decode(-1));
}
test('travel reads current-master states and hearthstone through the production inspector', () => {
  fixture(`
    local r=C.Inspect({kind='travel',args={limit=50}})
    assert(r.status=='available','travel inspection must be available')
    local d=r.data
    assert(d.bind.name=='Inn' and d.bind.status=='available' and d.bind.capturedAt==123)
    assert(d.hearthstone.owned and d.hearthstone.cooldown.state=='ready')
    assert(d.flights.status=='available' and d.flights.mapId==42 and d.flights.origin.nodeId==1)
    assert(d.flights.nodes[2].selectable==true and d.flights.nodes[2].position.x==.3)
    assert(d.flights.nodes[3].state=='unreachable' and d.flights.nodes[3].selectable==false)
    assert(d.flights.nodes[4].state=='unknown' and d.flights.nodes[4].selectable==nil)
    assert(d.flights.nodes[3].unlocked==nil and not d.flights.truncated)
  `);
});
test.each(
  ['bind', 'modern taxi', 'legacy taxi'].flatMap((source) =>
    ['é', '界', '🦅'].map((character) => ({ source, character })),
  ),
)('$source preserves UTF-8 boundaries for $character within 160 bytes', ({ source, character }) => {
  fixture(`
    local source=${JSON.stringify(source)}
    local character=${JSON.stringify(character)}
    for prefixLength=160-#character,159 do
      local prefix=string.rep('x',prefixLength)
      local nativeName=prefix..character..'tail'
      GetBindLocation=function()return nativeName end
      C_TaxiMap.GetAllTaxiNodes=function()return {{nodeID=1,name=nativeName,state=0,slotIndex=1}}end
      if source=='legacy taxi' then
        FlightMapFrame=nil
        TaxiFrame={IsShown=function()return true end}
        NumTaxiNodes=function()return 1 end
        TaxiNodeGetType=function()return 'CURRENT' end
        TaxiNodeName=function()return nativeName end
        TaxiNodePosition=function()return .2,.4 end
      end
      local d=C.Inspect({kind='travel',args={}}).data
      local name
      if source=='bind' then name=d.bind.name else name=d.flights.nodes[1].name end
      -- Validate raw Lua bytes before any JS decoder can replace invalid UTF-8.
      assert(utf8.len(name)~=nil,source..' contains a truncated UTF-8 codepoint')
      local expected=prefixLength+#character==160 and prefix..character or prefix
      assert(name==expected,source..' must retain the longest complete UTF-8 prefix')
      assert(#name<=160,source..' exceeds the byte bound')
    end
  `);
});
test('closed windows and origin changes never reuse a previous network, including late addon loads', () => {
  fixture(`
    local function inspect()return C.Inspect({kind='travel',args={}}).data end
    assert(inspect().flights.origin.nodeId==1, 'already-open window supported')
    for _,fn in ipairs(events)do fn(nil,'TAXIMAP_CLOSED')end
    assert(inspect().flights.status=='unavailable' and inspect().flights.nodes==nil)
    FlightMapFrame.IsShown=function()return false end
    for _,fn in ipairs(events)do fn(nil,'TAXIMAP_OPENED')end
    assert(inspect().flights.status=='unavailable','event alone is not UI presence')
    FlightMapFrame.IsShown=function()return true end
    FlightMapFrame.GetMapID=function()return 43 end
    C_TaxiMap.GetAllTaxiNodes=function(id)assert(id==43);return {{nodeID=9,name='New origin',state=0,slotIndex=1}}end
    assert(inspect().flights.origin.nodeId==9 and #inspect().flights.nodes==1)
    FlightMapFrame.GetMapID=function()error('restricted')end
    local d=inspect()
    assert(d.flights.status=='unavailable' and d.flights.nodes==nil and d.hearthstone.owned and d.bind.name=='Inn')
    FlightMapFrame.GetMapID=nil
    assert(inspect().flights.status=='unavailable')
  `);
});
test('missing, throwing, malformed and secret readings degrade independently', () => {
  fixture(`
    local function inspect()return C.Inspect({kind='travel',args={}}).data end
    for _,value in ipairs({false,42,'invalid',{bad='shape'},{{name='missing fields'}}})do
      C_TaxiMap.GetAllTaxiNodes=function()return value end
      local f=inspect().flights
      assert(f.status=='unavailable' or f.status=='partial')
    end
    C_TaxiMap.GetAllTaxiNodes=function()error('restricted')end
    assert(inspect().flights.status=='unavailable')
    C_TaxiMap=nil
    assert(inspect().flights.status=='unavailable')
    C_Item.GetItemCount=function()error('bags unavailable')end
    assert(inspect().hearthstone.status=='unavailable' and inspect().hearthstone.owned==nil)
    C_Item=nil;GetBindLocation=nil
    assert(inspect().bind.status=='unavailable' and inspect().hearthstone.status=='unavailable')
    C_Item={GetItemCount=function()return 1 end}
    local secret={}
    issecretvalue=function(v)return v==secret end
    C_Container.GetItemCooldown=function()return secret,0,1 end
    assert(inspect().hearthstone.cooldown.state=='unknown')
    GetBindLocation=function()return secret end
    assert(inspect().bind.status=='unavailable')
    C_Item.GetItemCount=function()return secret end
    assert(inspect().hearthstone.status=='unavailable')
  `);
});
test('hearthstone possession and both distinct native cooldown flag contracts preserve unknowns', () => {
  fixture(`
    local function hearth()return C.Inspect({kind='travel',args={}}).data.hearthstone end
    C_Container.GetItemCooldown=function()return 80,50,1 end
    assert(hearth().cooldown.remainingSeconds==30 and hearth().cooldown.state=='cooldown')
    C_Container.GetItemCooldown=function()return 20,50,1 end
    assert(hearth().cooldown.state=='ready')
    for _,flag in ipairs({0,false,true,2,'1'})do
      C_Container.GetItemCooldown=function()return 0,0,flag end
      assert(hearth().cooldown.state=='unknown')
    end
    C_Container=nil
    C_Item.GetItemCooldown=function()return 90,50,true end
    assert(hearth().cooldown.remainingSeconds==40 and hearth().cooldown.provenance=='C_Item.GetItemCooldown')
    for _,flag in ipairs({false,0,1,'true'})do
      C_Item.GetItemCooldown=function()return 0,0,flag end
      assert(hearth().cooldown.state=='unknown')
    end
    for _,bad in ipairs({-1,math.huge,0/0,'0',false})do
      C_Item.GetItemCooldown=function()return bad,0,true end
      assert(hearth().cooldown.state=='unknown')
    end
    C_Item.GetItemCooldown=function()return 101,5,true end
    assert(hearth().cooldown.state=='unknown')
    C_Item.GetItemCooldown=function()return 0,0,true end
    GetTime=nil
    assert(hearth().cooldown.state=='unknown')
    C_Item.GetItemCount=function()return 0 end
    local h=hearth()
    assert(h.status=='available' and h.owned==false and h.cooldown.state=='not_owned')
    C_Item.GetItemCount=function()return -1 end
    assert(hearth().status=='unavailable')
  `);
});
test('evidenced legacy TaxiFrame slot API reads only the open origin and labels map coverage', () => {
  fixture(`
    FlightMapFrame=nil
    TaxiFrame={IsShown=function()return true end}
    NumTaxiNodes=function()return 5 end
    TaxiNodeGetType=function(i)return ({'CURRENT','REACHABLE','UNREACHABLE','DISTANT','NEW_STATE'})[i]end
    TaxiNodeName=function(i)return 'Node '..i end
    TaxiNodePosition=function()return .2,.4 end
    local f=C.Inspect({kind='travel',args={}}).data.flights
    assert(f.status=='available' and f.mapStatus=='unavailable' and f.mapId==nil)
    assert(f.origin.slotIndex==1 and f.origin.nodeId==nil)
    assert(f.nodes[2].selectable and f.nodes[3].selectable==false)
    assert(f.nodes[4].state=='distant' and f.nodes[5].state=='unknown' and f.nodes[5].selectable==nil)
    TaxiNodeGetType=nil
    assert(C.Inspect({kind='travel',args={}}).data.flights.status=='unavailable')
  `);
});
test('map-layer transition entries are not selectable flight destinations', () => {
  fixture(`
    C_TaxiMap.GetAllTaxiNodes=function()return {
      {nodeID=1,name='Other map',slotIndex=1,state=1,isMapLayerTransition=true},
      {nodeID=2,name='Destination',slotIndex=2,state=1,isMapLayerTransition=false},
    }end
    local f=C.Inspect({kind='travel',args={}}).data.flights
    assert(f.nodes[1].selectable==false and f.nodes[1].mapLayerTransition==true)
    assert(f.nodes[2].selectable==true)
  `);
});
test('bounded observations contain only JSON-safe copied values and explicit truncation', () => {
  const json = fixture(`
    C_TaxiMap.GetAllTaxiNodes=function()
      local nodes={}
      for i=1,600 do nodes[i]={nodeID=i,name=string.rep('x',500),state=1,slotIndex=i,position={x=.1,y=.2,GetXY=function()return .1,.2 end},unused=function()end}end
      return nodes
    end
    local r=C.Inspect({kind='travel',args={limit=100}})
    snapshot=r
    local f=r.data.flights
    assert(f.status=='partial' and f.truncated and #f.nodes==100 and f.total==600 and f.scanned==512)
    assert(#f.nodes[1].name==160 and f.nodes[1].position.GetXY==nil and f.nodes[1].unused==nil)
    local fields=0
    local function jsonSafe(v)
      local t=type(v)
      assert(t=='table' or t=='string' or t=='number' or t=='boolean')
      if t=='table' then for k,x in pairs(v)do assert(type(k)=='string' or type(k)=='number');fields=fields+1;jsonSafe(x)end
      elseif t=='number' then assert(v==v and math.abs(v)<math.huge)end
    end
    jsonSafe(r)
    assert(fields<1500)
    assert(C.Inspect({kind='travel',args={limit=101}}).status=='unavailable')
  `);
  assert.ok(Buffer.byteLength(json) < MAX_DECODED_BYTES);
  const body = deflateSync(json);
  assert.ok(body.length < MAX_ENCODED_BYTES);
  const transported = JSON.parse(inflateMessage({ body, flags: COMPRESSED }).toString());
  assert.equal(transported.data.flights.nodes.length, 100);
  assert.deepEqual(transported, JSON.parse(json));
});
