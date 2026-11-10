import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  DOWNLINK_HELPERS,
  decodeFrame,
  encodeFrame,
} from '../../packages/protocol/src/mailbox.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// Both session rejection and bulk-read outcome reporting come from production
// Core; the checked control, native bit mapping and startup gates use Transport.
test('switching away or starting another chat discards unused conversations', () => {
  const { run } = reloadHarness();
  run(`
    ns.Transport.Send=function()end;ns.UI.Refresh=function()end
    ns.chats={{id='saved',title='Saved',messages={{role='user',text='Hello'}},status='done'}}
    ns.active='saved'
    ns.Chat.NewChat()
    local draft=ns.active
    assert(#ns.chats==2)
    ns.Chat.Select('saved')
    assert(#ns.chats==1 and ns.chats[1].id=='saved')
    assert(ns.pendingChats[draft]==nil)
    ns.Chat.NewChat()
    ns.Chat.NewChat()
    assert(#ns.chats==2)
    ns.Chat.Current().messages={{role='user',text='Keep me'}}
    ns.Chat.Select('saved')
    assert(#ns.chats==2)
  `);
});

function reloadHarness() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
  run(`
SlashCmdList={};DEFAULT_CHAT_FRAME={AddMessage=function(text)logs[#logs+1]=text end}
function CreateFrame()return{RegisterEvent=function()end,SetScript=function()end}end
`);
  for (const file of ['Core.lua', 'Chat/State.lua', 'Chat/Snapshot.lua']) {
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + file, 'utf8'))}))('WispAI',ns)`,
    );
  }
  run(`
ns.session='fresh-addon-session';ns.db={drafts={}}
saves=0;resets=0;loadedNames={}
C_EncodingUtil.DecompressString=function(text)return text end
C_EncodingUtil.DeserializeJSON=function(text)
 if text=='bulk payload' then return payload end
 local revision=text:match('^%{"r":(%d+)%}$')
 assert(revision,'Unexpected JSON fixture');return{r=tonumber(revision)}
end
local reset=C_AddOns.ResetAddOns
C_AddOns.ResetAddOns=function()resets=resets+1;reset()end
C_AddOns.LoadAddOn=function(name)
 assert(states[name],'bulk helper must be temporarily enabled')
 loadedNames[#loadedNames+1]=name;loads=loads+1
 if onLoad then return onLoad(name) end
 WispAI_Receive('bulk payload');return true
end
local save=C_AddOns.SaveAddOns
C_AddOns.SaveAddOns=function()
 saves=saves+1;save()
 local bytes={}
 for byte=0,95 do
  local value=0
  for position=0,7 do
   if states[string.format('WispAI_S%04d',257+byte*8+position)]then value=value+2^position end
  end
  bytes[#bytes+1]=string.char(value)
 end
 saved=table.concat(bytes)
end
function bulkPayload(session,revision)
 payload={v=1,session=session,rev=revision,connected=true,chats={},acks={1}}
end
`);
  for (const name of ['Transport/Downlink.lua', 'Transport/Transport.lua']) {
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + name, 'utf8'))}))('WispAI',ns)`,
    );
  }
  run('assert(ns.Transport.StartTransport());assert(resets==0 and saves==0)');
  return {
    run,
    control: (revision: number, sequence = revision) => {
      const frame = encodeFrame({
        kind: COMPACT_DOWNLINK_KIND,
        flags: 3,
        generation: 91,
        sequence,
        payload: Buffer.from(JSON.stringify({ r: revision })),
      });
      run(
        DOWNLINK_HELPERS.map(
          (name, index) => `disk['${name}']=${Boolean(frame[index >> 3] & (1 << (index % 8)))}`,
        ).join(';'),
      );
    },
    ack: () => {
      lua.lua_getglobal(L, to_luastring('saved'));
      const bytes = Buffer.from(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return decodeFrame(bytes.subarray(0, 16));
    },
  };
}

test('reload ignores the persisted control before hello and waits for a fresh bulk publication', () => {
  const h = reloadHarness();
  h.control(17);
  h.run(`
bulkPayload('previous-addon-session',17)
ns.Transport.Send({type='hello'})
AddonList={IsShown=function()return true end}
now=.04;timers[.04]();timers[.1]()
assert(resets==0 and saves==0 and loads==0,'settings pause must precede startup baselining')
AddonList=nil
now=.08;timers[.04]()
assert(resets==1 and saves==1,'capture the physical baseline exactly once before first uplink')
for i=1,20 do now=now+.1;timers[.05]();timers[.1]();timers[.5]()end
assert(loads==0 and ns.slot==1 and ns.rev==0 and not ns.bulkUnavailable)
`);
  h.control(18);
  h.run(`
bulkPayload(ns.session,18)
now=now+.2;timers[.1]();timers[.05]()
assert(loads==1 and ns.slot==2 and ns.rev==18 and ns.connected)
assert(ns.bulkRead==nil and not ns.bulkUnavailable and #logs==0)
now=now+.04;timers[.04]()
`);
  expect(h.ack()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 2, sequence: 18 });
});

test('a changed old-session publication during multipart hello preserves the bank for the next fresh helper', () => {
  const h = reloadHarness();
  h.control(17);
  h.run(`
bulkPayload('previous-addon-session',17)
C_EncodingUtil.SerializeJSON=function()return string.rep('x',200)end
ns.Transport.Send({type='hello'})
now=.04;timers[.04]()
assert(saves==1 and resets==1)
`);
  h.control(18);
  h.run(`
bulkPayload('previous-addon-session',18)
now=.06;timers[.1]();assert(loads==0,'multipart uplink must still prevent reset reads')
now=.08;timers[.04]();now=.12;timers[.04]()
assert(saves==3 and resets==1)
`);
  // The host reasserts control after the game's final save, which rewrites the
  // entire settings file from its current memory view.
  h.control(18);
  h.run(`
now=.2;timers[.1]()
assert(loads==1 and ns.slot==2 and ns.rev==0 and not ns.connected)
assert(ns.transportStats.staleBulkReads==1 and not ns.bulkUnavailable and ns.bulkRead==nil)
assert(ns.transportStats.loadError==nil)
now=.24;timers[.04]()
`);
  expect(h.ack()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 3, sequence: 18 });
  h.control(19);
  h.run(`
bulkPayload(ns.session,19)
now=.4;timers[.05]()
assert(loads==2 and ns.slot==3 and ns.rev==19 and ns.connected)
assert(loadedNames[1]=='WispAI_S0001' and loadedNames[2]=='WispAI_S0002')
assert(not ns.bulkUnavailable and ns.bulkRead==nil and #logs==0)
now=.44;timers[.04]()
`);
  expect(h.ack()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 2, sequence: 19 });
});

test.each([
  ['native failure', "onLoad=function()return nil,'MISSING'end"],
  ['raised load error', "onLoad=function()error('native load error')end"],
  ['unapplied current-session payload', 'ns.rev=1;bulkPayload(ns.session,1)'],
  ['empty installer payload', "payload={v=1,session='',connected=false}"],
])('%s still selects fallback and clears the scoped bulk outcome', (_, mode) => {
  const h = reloadHarness();
  h.run("ns.Transport.Send({type='hello'});now=.04;timers[.04]()");
  h.control(1);
  h.run('bulkPayload(ns.session,1);now=.2;timers[.1]();now=.24;timers[.04]();assert(ns.rev==1)');
  h.control(2);
  h.run(`
bulkPayload(ns.session,2)
${mode}
now=.4;timers[.05]()
assert(loads==2 and ns.bulkUnavailable and ns.bulkRead==nil)
assert(ns.transportStats.error==nil,'load errors must be contained with cleanup')
assert(states.WispAI_S0002==disk.WispAI_S0002,'temporary helper enable state must be restored')
now=.44;timers[.04]()
`);
  expect(h.ack()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 1, sequence: 2 });
});

test('an old payload at the final bulk slot cannot advertise a bank beyond its actual capacity', () => {
  const h = reloadHarness();
  h.run("ns.Transport.Send({type='hello'});now=.04;timers[.04]();ns.slot=1024");
  h.control(2);
  h.run(`
bulkPayload('previous-addon-session',2)
now=.2;timers[.1]()
assert(ns.slot==1025 and not ns.bulkUnavailable and ns.transportStats.staleBulkReads==1)
now=.24;timers[.04]()
`);
  expect(h.ack()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 1, sequence: 2 });
});
