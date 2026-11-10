import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function fixture() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(`
C={}
unpack=table.unpack
function time() return 123 end
CreateFrame=function()return {RegisterEvent=function()end,SetScript=function()end}end
function CastSpellByID()error('write forbidden')end
SendChatMessage=CastSpellByID; UseItemByName=CastSpellByID; SetRaidTarget=CastSpellByID
roster={player='self',party1='buffed',party2='missing',party3='offline',party4='hidden'}
function IsInRaid()return false end
function GetNumSubgroupMembers()return 4 end
function UnitGUID(u)return roster[u] end
function UnitName(u)return roster[u] end
function UnitClass()return 'Mage','MAGE' end
function UnitLevel()return 20 end
function UnitExists(u)return roster[u]~=nil end
function UnitIsConnected(u)return u~='party3' end
function UnitIsVisible(u)return u~='party4' end
function UnitIsDeadOrGhost()return false end
C_UnitAuras={GetAuraDataByIndex=function(u,i,filter)
 assert(filter=='HELPFUL')
 if u=='party3' or u=='party4' then error('unreadable unit must not be scanned') end
 if i==1 and u=='party1' then return {spellId=1459} end
end}
`);
  for (const name of ['Group', 'Character']) {
    const path = `addon/WispAI/${name}.lua`;
    run(`assert(load(${JSON.stringify(readFileSync(path, 'utf8'))}))('WispAI',C)`);
  }
  const value = (index: number): unknown => {
    switch (lua.lua_type(L, index)) {
      case lua.LUA_TNIL:
        return null;
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, index);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, index);
      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tolstring(L, index));
      case lua.LUA_TTABLE: {
        const absolute = lua.lua_absindex(L, index);
        const entries: [string | number, unknown][] = [];
        lua.lua_pushnil(L);
        while (lua.lua_next(L, absolute)) {
          entries.push([value(-2) as string | number, value(-1)]);
          lua.lua_pop(L, 1);
        }
        return entries.length > 0 && entries.every(([key]) => typeof key === 'number')
          ? entries.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v)
          : Object.fromEntries(entries);
      }
      default:
        throw Error('Non-JSON Lua value');
    }
  };
  return Object.assign(run, {
    snapshot: () => {
      lua.lua_getglobal(L, to_luastring('result'));
      const result = value(-1);
      lua.lua_pop(L, 1);
      return result;
    },
  });
}

test('party helpful aura absence is known only for complete readable members', () => {
  fixture()(`
local r=C.Inspect({kind='group',args={spellIds={1459}}})
assert(r.status=='available', 'group inspection must be callable')
assert(r.character==nil, 'group envelope must not copy unvalidated identity')
local d=r.data
assert(d.mode=='party' and #d.members==5 and d.capturedAt==123)
assert(d.members[2].auras[1].spellId==1459 and d.members[2].auraCoverage=='complete')
assert(d.members[3].auraCoverage=='complete' and d.members[3].matches[1].present==false)
assert(d.members[2].matches[1].present==true)
for i=4,5 do
 assert(d.members[i].auraCoverage=='unknown' and d.members[i].matches[1].present==nil)
end
assert(d.members[3].dead==false and d.members[3].guid=='missing')
`);
});

test('maximal actual Lua snapshot remains JSON encodable and bounded', () => {
  const run = fixture();
  run(`
UnitName=function()return string.rep('"',120)end
UnitGUID=function(u)return u..string.rep('g',110)end
UnitClass=function()return 'Mage',string.rep('M',32)end
UnitIsConnected=function()return true end
UnitIsVisible=function()return true end
C_UnitAuras.GetAuraDataByIndex=function(u,i)if i<=64 then return {spellId=2147483647-i}end end
result=C.Inspect({kind='group',args={}})
assert(result.status=='available' and #result.data.members==5)
for _,m in ipairs(result.data.members)do assert(#m.auras==64 and m.auraCoverage=='complete')end
`);
  const json = JSON.stringify(run.snapshot());
  expect(Buffer.byteLength(json)).toBeLessThan(16000);
  expect(JSON.parse(json).data.members).toHaveLength(5);
});

test('fresh requests replace departed members and invalidate a roster changing during enumeration', () => {
  fixture()(`
local function get()return C.Inspect({kind='group',args={spellIds={1459}}}).data end
assert(get().members[2].guid=='buffed')
roster.party1='replacement'
C_UnitAuras.GetAuraDataByIndex=function()return nil end
local d=get()
assert(d.members[2].guid=='replacement' and d.members[2].matches[1].present==false)
roster.party4=nil
GetNumSubgroupMembers=function()return 3 end
assert(#get().members==4)
C_UnitAuras.GetAuraDataByIndex=function(u)
 if u=='party2' then roster.party1='changed-mid-read' end
 return nil
end
d=get()
assert(d.rosterCoverage=='partial' and d.coverage=='partial')
for _,m in ipairs(d.members)do assert(m.auraCoverage=='unknown' and m.matches[1].present==nil and #m.auras==0)end
`);
});

test('solo, unsupported raid and unavailable roster are distinct, without fallback or polling', () => {
  fixture()(`
local function get()return C.Inspect({kind='group',args={}}).data end
GetNumSubgroupMembers=function()return 0 end
local d=get()
assert(d.mode=='solo' and #d.members==1 and d.coverage=='complete')
IsInRaid=function()return true end
C_UnitAuras.GetAuraDataByIndex=function()error('raid must not scan')end
d=get()
assert(d.mode=='raid' and d.rosterCoverage=='unsupported' and #d.members==0)
IsInRaid=nil
d=get()
assert(d.mode=='unknown' and d.rosterCoverage=='unknown' and #d.members==0)
IsInRaid=function()return false end
GetNumSubgroupMembers=function()return 5 end
assert(get().mode=='unknown')
GetNumSubgroupMembers=function()error('not ready')end
assert(get().mode=='unknown')
`);
});

test('missing, throwing, invalid and restricted aura reads stay unknown; valid nil means complete empty', () => {
  fixture()(`
GetNumSubgroupMembers=function()return 0 end
local function get()return C.Inspect({kind='group',args={spellIds={1459}}}).data.members[1] end
assert(get().matches[1].present==false)
for _,api in ipairs({{}, {GetAuraDataByIndex=function()error('restricted')end},
 {GetAuraDataByIndex=function()return false end},
 {GetAuraDataByIndex=function()return {} end},
 {GetAuraDataByIndex=function()return {spellId='1459'} end},
 {GetAuraDataByIndex=function()return {spellId=0/0} end},
 {GetAuraDataByIndex=function()return setmetatable({}, {__index=function()error('secret')end}) end}})do
 C_UnitAuras=api
 local m=get()
 assert(m.auraCoverage=='unknown' and m.matches[1].present==nil)
end
C_UnitAuras=nil
assert(get().auraCoverage=='unknown')
local secret={}
issecretvalue=function(v)return v==secret end
C_UnitAuras={GetAuraDataByIndex=function()return secret end}
assert(get().matches[1].present==nil)
C_UnitAuras.GetAuraDataByIndex=function()return {spellId=secret}end
assert(get().auraCoverage=='unknown')
-- Even a secret nil sentinel is not accepted as a complete empty list.
issecretvalue=function(v)return v==nil end
C_UnitAuras.GetAuraDataByIndex=function()return nil end
assert(get().auraCoverage=='unknown')
`);
});

test('invalid identity and unit state cannot turn unreadable members into known absence', () => {
  fixture()(`
GetNumSubgroupMembers=function()return 0 end
local function get()return C.Inspect({kind='group',args={spellIds={1459}}}).data.members[1] end
for _,fn in ipairs({function()return nil end,function()return 1 end,function()error('restricted')end})do
 UnitIsVisible=fn
 local m=get()
 assert(m.visible==nil and m.auraCoverage=='unknown' and m.matches[1].present==nil)
end
UnitIsVisible=function()return true end
UnitGUID=function()return nil end
assert(get().matches[1].present==nil)
UnitGUID=function()return 'self' end
UnitExists=function()return false end
assert(get().auraCoverage=='unknown')
UnitExists=function()return true end
UnitName=function()return string.rep('x',121)end
UnitLevel=function()return math.huge end
UnitClass=function()return 'Mage',{}end
UnitIsDeadOrGhost=function()return 'false'end
local m=get()
assert(m.name==nil and m.level==nil and m.class==nil and m.dead==nil and #m.unknownFields==4)
`);
});

test('bounded enumeration preserves positive exact IDs but never truncated or failed absence', () => {
  fixture()(`
GetNumSubgroupMembers=function()return 0 end
local calls=0
C_UnitAuras.GetAuraDataByIndex=function(u,i)
 calls=calls+1
 return {spellId=i==1 and 1459 or 10000+i, name=string.rep('x',1000)}
end
local function get(args)return C.Inspect({kind='group',args=args or {spellIds={1459,999}}}).data.members[1]end
local m=get()
assert(calls==65 and m.truncated and m.auraCoverage=='partial' and #m.auras==1)
assert(m.matches[1].present==true and m.matches[2].present==nil and m.auras[1].name==nil)
m=get({})
assert(#m.auras==64 and m.truncated)
C_UnitAuras.GetAuraDataByIndex=function(u,i)if i<=64 then return {spellId=i} end end
m=get()
assert(not m.truncated and m.auraCoverage=='complete' and m.matches[1].present==false)
C_UnitAuras.GetAuraDataByIndex=function(u,i)if i==1 then return {spellId=1459} end error('lost access')end
m=get()
assert(m.auraCoverage=='partial' and m.matches[1].present==true and m.matches[2].present==nil)
`);
});
