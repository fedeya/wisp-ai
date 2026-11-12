import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import {
  MailboxDecoder,
  inflateMessage,
  UPLINK_HELPERS,
  UPLINK_KIND,
} from '../../packages/protocol/src/mailbox.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

test.each([
  { kind: 'entropy', offset: 500, count: 1000 },
  { kind: 'escaping', offset: 500, count: 1000 },
  { kind: 'localized', offset: 500, count: 1000 },
  { kind: 'entropy', offset: 0, count: 40 },
])(
  'merchant $kind offset=$offset survives the production inspect/send path',
  { timeout: 30000 },
  ({ kind, offset, count }) => {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const run = (source: string) => {
      if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
        throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
      }
    };
    // Same native boundary and carrier fixture as channel-budget/transport-v2.
    run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
    function read(at: number): unknown {
      const type = lua.lua_type(L, at);
      if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, at);
      if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, at);
      if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tolstring(L, at));
      if (type !== lua.LUA_TTABLE) throw Error('Not JSON');
      const index = lua.lua_absindex(L, at);
      const values: Record<string, unknown> = {};
      let array = true;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, index)) {
        const key = read(-2);
        array &&= typeof key === 'number';
        values[String(key)] = read(-1);
        lua.lua_pop(L, 1);
      }
      return array ? Object.values(values) : values;
    }
    const jsonSizes: number[] = [];
    const compressedSizes: number[] = [];
    lua.lua_pushcfunction(L, () => {
      const json = JSON.stringify(read(1));
      jsonSizes.push(Buffer.byteLength(json));
      lua.lua_pushstring(L, to_luastring(json));
      return 1;
    });
    lua.lua_setglobal(L, to_luastring('serialize'));
    lua.lua_pushcfunction(L, () => {
      const bytes = deflateSync(Buffer.from(lua.lua_tolstring(L, 1)));
      compressedSizes.push(bytes.length);
      lua.lua_pushlstring(L, bytes, bytes.length);
      return 1;
    });
    lua.lua_setglobal(L, to_luastring('compress'));
    const decoder = new MailboxDecoder(UPLINK_KIND);
    let decoded: any;
    lua.lua_pushcfunction(L, () => {
      const bytes = Buffer.alloc(96);
      lua.lua_getglobal(L, to_luastring('states'));
      UPLINK_HELPERS.forEach((name, index) => {
        lua.lua_getfield(L, -1, to_luastring(name));
        if (lua.lua_toboolean(L, -1)) bytes[index >> 3] |= 1 << (index & 7);
        lua.lua_pop(L, 1);
      });
      lua.lua_pop(L, 1);
      const message = decoder.add(bytes);
      if (message) decoded = JSON.parse(inflateMessage(message).toString());
      return 0;
    });
    lua.lua_setglobal(L, to_luastring('save'));
    run(`
C_EncodingUtil.SerializeJSON=serialize
C_EncodingUtil.CompressString=compress
C_AddOns.SaveAddOns=save
events={}
function CreateFrame() return {RegisterEvent=function()end,SetScript=function(_,_,fn)events[#events+1]=fn end} end
function UnitGUID(unit) return unit=='player' and 'Player-Test-GUID' or 'Creature-0-0-0-0-123-0' end
function UnitName() return string.rep('\\1',200) end
MerchantFrame={selectedTab=1,IsShown=function()return true end}
function GetMerchantNumItems()return ${count} end
local seed=12345
local function text(n)
 local out={}
 for i=1,n do
  seed=(seed*16807.0)%2147483647
  local v=math.floor(seed)%90
  out[#out+1]=${kind === 'localized' ? 'utf8.char(0x4e00+math.floor(seed)%20000)' : kind === 'escaping' ? 'string.char(math.floor(seed)%32)' : 'string.char(33+v)'}
 end
 return table.concat(out)
end
function GetMerchantItemInfo()return text(200),nil,120,5,17,true,false,false end
function GetMerchantItemLink(i)return 'item:'..i..':'..text(490) end
C_TooltipInfo={GetMerchantItem=function()
 local lines={}
 for i=1,12 do lines[i]={leftText=text(256),rightText=text(256)} end
 return {lines=lines}
end}
`);
    for (const name of [
      'Namespace.lua',
      'Shared/Numbers.lua',
      'Shared/Text.lua',
      'Character/Merchant.lua',
      'Character/Inspect.lua',
      'Transport/Transport.lua',
    ]) {
      run(
        `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + name, 'utf8'))}))('WispAI',ns)`,
      );
    }
    run(`
for _,fn in ipairs(events)do fn(nil,'MERCHANT_SHOW')end
ns.Transport.StartTransport()
local result=ns.Character.Inspect({kind='merchant',args={offset=${offset},limit=40}})
assert(result.status=='available')
-- Maximum schema lengths, with worst-case JSON escaping in packet metadata.
ns.session=string.rep('\\1',100)
ns.Transport.Send({type='state_result',chat=string.rep('\\1',200),requestId=string.rep('\\1',200),data=result})
for i=1,820 do timers[.04]()end
`);
    expect(decoded.data.status).toBe('available');
    expect(decoded.requestId).toBe('\x01'.repeat(200));
    const data = decoded.data.data;
    expect(data.merchant.npcId).toBe(123);
    expect(data.offers.length).toBeGreaterThan(0);
    expect(data.offers[0]).toMatchObject({
      index: offset + 1,
      itemId: offset + 1,
      costCopper: 120,
      bundleSize: 5,
      availableCount: 17,
      isUsable: false,
    });
    expect(data.truncated).toBe(true);
    expect(data.totalVisibleOffers).toBe(count);
    expect(data.offers.length).toBeLessThan(40);
    expect(data.offers.some((offer: any) => offer.tooltipTruncated)).toBe(true);
    expect(
      data.offers.some(
        (offer: any) =>
          !offer.tooltip && offer.tooltipTruncated && offer.requirementsStatus === 'unavailable',
      ),
    ).toBe(true);
    expect(JSON.stringify(decoded)).not.toContain('\uFFFD');
    expect(Math.max(...jsonSizes)).toBeLessThan(60000);
    expect(Math.max(...compressedSizes)).toBeLessThanOrEqual(65535);
    console.info({
      kind,
      offset,
      offers: data.offers.length,
      jsonBytes: Math.max(...jsonSizes),
      compressedBytes: Math.max(...compressedSizes),
    });
  },
);

test('merchant advice clamps spendable and defines safe arithmetic boundaries', () => {
  const skill = readFileSync('apps/agent/agent/skills/merchant/SKILL.md', 'utf8');
  const expression = skill.match(/spendable = `([^`]+)`/)?.[1];
  expect(expression).toBe('max(0, min(B, M - R))');
  expect(skill).toContain('only a budget is given, R = 0');
  expect(skill).toContain('only a reserve is given, B = M');
  expect(skill).toContain('Missing/unknown money blocks exact affordability');
  expect(skill).toContain('zero money is known');
  for (const [M, B, R, expected] of [
    [500, 300, 600, 0],
    [500, 300, 0, 2],
    [500, 500, 200, 2],
    [0, 300, 0, 0],
    [500, 0, 0, 0],
    [500, 300, 500, 0],
  ]) {
    const spendable = runInNewContext(expression!, { M, B, R, min: Math.min, max: Math.max });
    const purchases = Math.floor(spendable / 120);
    expect(purchases).toBe(expected);
    expect(purchases * 5).toBe(expected * 5);
    expect(M - purchases * 120).toBeGreaterThanOrEqual(0);
  }
  for (const [stock, expected] of [
    [8, 1],
    [0, 0],
  ]) {
    expect(Math.min(2, Math.floor(stock / 5))).toBe(expected);
  }
  expect(skill).toContain('zero-cost bundles separately (no division)');
  expect(skill).toContain('never assume unlimited free quantities');
  expect(skill).toContain(
    'Never claim an exact affordable quantity when bundle size, stock or cost is unknown',
  );
});
