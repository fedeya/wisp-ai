import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

test('diag reports the loaded addon build, unknown bridge and actual version mismatches', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(`
    logs={}; SlashCmdList={}; C={slot=1}
    function time()return 1 end
    function CreateFrame()return {RegisterEvent=function()end,SetScript=function()end}end
    DEFAULT_CHAT_FRAME={AddMessage=function(_,text)logs[#logs+1]=text end}
    C_AddOns={GetAddOnMetadata=function(name,key) assert(name=='WispAI' and key=='Version');return '0.0.8-nightly.123.2' end}
  `);
  run(`assert(load(${JSON.stringify(readFileSync('addon/WispAI/Core.lua', 'utf8'))}))('WispAI',C)`);
  run(`
    assert(C.VERSION==1)
    SlashCmdList.WISPAI('diag')
    assert(logs[1]:find('Addon 0.0.8-nightly.123.2',1,true))
    assert(logs[1]:find('desktop/bridge unknown',1,true))
    assert(not logs[1]:find('version mismatch',1,true))
    C.db={drafts={}}; C.Acknowledge=function()end; GetTime=function()return 1 end
    C.ReceiveSnapshot({v=1,session=C.session,rev=1,connected=true,bridgeVersion='0.0.7'})
    logs={};SlashCmdList.WISPAI('diag')
    assert(logs[1]:find('desktop/bridge 0.0.7',1,true))
    assert(logs[1]:find('version mismatch',1,true))
    C.ReceiveSnapshot({v=1,session=C.session,rev=2,connected=true,bridgeVersion=C.addonVersion})
    logs={};SlashCmdList.WISPAI('diag')
    assert(not logs[1]:find('version mismatch',1,true))
    C.ReceiveSnapshot({v=1,session=C.session,rev=3,connected=true})
    logs={};SlashCmdList.WISPAI('diag')
    assert(logs[1]:find('desktop/bridge unknown',1,true))
  `);
  expect(true).toBe(true);
});
