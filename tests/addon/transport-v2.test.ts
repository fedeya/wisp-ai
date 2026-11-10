import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import {
  DOWNLINK_HELPERS,
  DOWNLINK_KIND,
  UPLINK_KIND,
  FIRST,
  LAST,
  encodeFrame,
  decodeFrame,
} from '../../packages/protocol/src/mailbox.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function transportHarness(start = true, beforeLoad = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
  run(`
bit={bxor=function(a,b)return a~b end,band=function(a,b)return a&b end,rshift=function(a,b)return a>>b end}
playerGuid=nil
function UnitGUID(unit)assert(unit=='player');return playerGuid end
function GetTimePreciseSec()return now end
states={};disk={};saves=0;resets=0;stateReads=0;stateChanges=0;logs={};loadedNames={};decodeMap={}
for i=1,128 do local n=string.format('WispAI_B%03d',i);states[n]=true;disk[n]=true end
for i=1,1024 do local n=string.format('WispAI_S%04d',i);states[n]=true;disk[n]=true end
local fixtureLoad=C_AddOns.LoadAddOn
local function check(name,character)
 assert(character=='Player-Test-GUID','native state API must use the active character GUID')
 assert(states[name]~=nil,'unknown helper '..tostring(name))
end
C_AddOns.DoesAddOnExist=function(name)return states[name]~=nil end
C_AddOns.GetAddOnEnableState=function(name,character)check(name,character);stateReads=stateReads+1;return states[name]and 2 or 0 end
C_AddOns.EnableAddOn=function(name,character)check(name,character);stateChanges=stateChanges+1;states[name]=true end
C_AddOns.DisableAddOn=function(name,character)check(name,character);stateChanges=stateChanges+1;states[name]=false end
C_AddOns.ResetAddOns=function()resets=resets+1;for name,value in pairs(disk)do states[name]=value end end
C_AddOns.SaveAddOns=function()
 saves=saves+1
 for name,value in pairs(states)do disk[name]=value end
 local bytes={}
 for byte=0,95 do
  local value=0
  for position=0,7 do
   if states[string.format('WispAI_S%04d',257+byte*8+position)]then value=value+2^position end
  end
  bytes[#bytes+1]=string.char(value)
 end
 lastSavedUplink=table.concat(bytes)
end
C_AddOns.LoadAddOn=function(name)
 assert(states[name],'bulk helper must be enabled while loading')
 loadedNames[#loadedNames+1]=name
 return fixtureLoad(name)
end
C_EncodingUtil.DeserializeJSON=function(text)
 assert(decodeMap[text]~=nil,'only the supplied checked notification JSON can be decoded')
 return {r=decodeMap[text]}
end
C.Log=function(text)logs[#logs+1]=tostring(text)end
`);
  run(beforeLoad);
  run(
    `assert(load(${JSON.stringify(readFileSync('addon/WispAI/Transport.lua', 'utf8'))}))('WispAI',C)`,
  );
  const activate = () =>
    run("playerGuid='Player-Test-GUID';C.StartTransport();assert(C.transportStats.version==2)");
  if (start) {
    activate();
  }
  return {
    run,
    activate,
    control: (revision: number, generation = 0xfedcba98, mutate?: (frame: Buffer) => void) => {
      const payload = JSON.stringify({ r: revision });
      const frame = encodeFrame({
        kind: DOWNLINK_KIND,
        flags: FIRST | LAST,
        generation,
        sequence: revision & 65535,
        payload: Buffer.from(payload),
      });
      mutate?.(frame);
      run(
        `decodeMap[${JSON.stringify(payload)}]=${revision};` +
          DOWNLINK_HELPERS.map(
            (name, index) => `disk['${name}']=${Boolean(frame[index >> 3] & (1 << (index % 8)))}`,
          ).join(';'),
      );
    },
    saved: () => {
      lua.lua_getglobal(L, to_luastring('lastSavedUplink'));
      const result = Buffer.from(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return result;
    },
  };
}

test('cold login queues only v2 before the player GUID becomes available', () => {
  const h = transportHarness(false);
  h.run("assert(C.transportStats.version==2);C.Send({type='hello'})");
  h.activate();
  h.run(
    'now=.04;timers[.04]();assert(saves==1 and #logs==0);assert(packets[#packets].transportVersion==2)',
  );
  const frame = decodeFrame(h.saved());
  expect(frame?.kind).toBe(UPLINK_KIND);
  expect(frame?.payload.toString()).toBe('{}');
});

test.each([
  ['bit operations', 'bit=nil', 'bit.bxor'],
  ['native reset', 'C_AddOns.ResetAddOns=nil', 'C_AddOns.ResetAddOns'],
  ['native state reads', 'C_AddOns.GetAddOnEnableState=nil', 'C_AddOns.GetAddOnEnableState'],
  ['JSON decoding', 'C_EncodingUtil.DeserializeJSON=nil', 'C_EncodingUtil.DeserializeJSON'],
  ['JSON utilities', 'C_EncodingUtil=nil', 'C_EncodingUtil.SerializeJSON'],
  ['player identity API', 'UnitGUID=nil', 'UnitGUID'],
])('missing %s fails once without legacy frames or transport tickers', (_, setup, expected) => {
  const h = transportHarness(false, setup);
  h.run(`
assert(C.StartTransport()==false)
assert(C.StartTransport()==false)
assert(C.Send({type='hello'})==false)
assert(#logs==1 and logs[1]:find(${JSON.stringify(expected)},1,true))
assert(next(timers)==nil and saves==0 and resets==0 and loads==0)
assert(#packets==0 and C.transportStats.version==2)
`);
});

test('an unavailable character GUID fails once and a later start uses queued v2 only', () => {
  const h = transportHarness(false);
  h.run(`
C.Send({type='hello'})
assert(C.StartTransport()==false and C.StartTransport()==false)
assert(#logs==1 and logs[1]:find('GUID',1,true))
assert(next(timers)==nil and saves==0 and resets==0 and loads==0)
`);
  h.activate();
  h.run('now=.04;timers[.04]();assert(saves==1 and C.transportStats.error==nil)');
  expect(decodeFrame(h.saved())?.kind).toBe(UPLINK_KIND);
});

test('missing, corrupt, zero-generation and noncanonical readiness consume no bulk channels', () => {
  const h = transportHarness();
  h.run("C.Send({type='hello'});timers[.04]()");
  h.run('for i=1,100 do now=now+.1;timers[.1]()end;assert(loads==0 and resets>50 and #logs==0)');
  h.control(1, 17, (frame) => {
    frame[15] ^= 1;
  });
  h.run('now=now+1;timers[.1]();assert(loads==0)');
  h.control(1, 17, (frame) => {
    frame.writeUInt32BE(0, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 44)), 44);
  });
  h.run('now=now+1;timers[.1]();assert(loads==0)');
  h.control(1, 17, (frame) => {
    frame[43] = 1;
    frame.writeUInt32BE(crc32(frame.subarray(0, 44)), 44);
  });
  h.run('now=now+1;timers[.1]();assert(loads==0 and #logs==0)');
});

test('new checked revisions load once and repeated readiness never burns unchanged slots', () => {
  const h = transportHarness();
  h.run("C.Send({type='hello'});timers[.04]()");
  h.control(1);
  h.run("nextRev=1;now=1;timers[.1]();assert(loads==1 and C.rev==1);C.chats[1].status='working'");
  h.run('for i=1,100 do now=now+.1;timers[.1]()end;assert(loads==1 and C.slot==2)');
  h.control(2);
  h.run(
    'nextRev=2;now=now+1;timers[.1]();assert(loads==2 and C.rev==2 and C.slot==3 and #logs==0)',
  );
});

test('a bulk helper overlapping the uplink preserves its disabled state and uses an explicit character', () => {
  const h = transportHarness();
  h.run("C.Send({type='hello'});timers[.04]()");
  h.run('C.slot=257;states.WispAI_S0257=false;disk.WispAI_S0257=false');
  h.control(1);
  h.run(
    "nextRev=1;now=1;timers[.1]();assert(loads==1 and loadedNames[1]=='WispAI_S0257');assert(states.WispAI_S0257==false and disk.WispAI_S0257==false and #logs==0)",
  );
});

test('addon settings pause both writes and reset reads without discarding user edits', () => {
  const h = transportHarness();
  h.control(1);
  h.run(`
C.Send({type='poll'})
AddonList={IsShown=function()return true end}
states.WispAI_S0257=false
now=1;timers[.04]();timers[.1]()
assert(saves==0 and resets==0 and loads==0 and states.WispAI_S0257==false)
AddonList=nil
timers[.04]()
assert(saves==1 and #logs==0)
`);
  expect(decodeFrame(h.saved())?.kind).toBe(UPLINK_KIND);
});

test('reset invalidates cached uplink bits so a following publication remains CRC-valid', () => {
  const h = transportHarness();
  h.run(
    "C.connected=true;C.chats[1].status='working';C.Send({type='poll'});now=.04;timers[.04]();assert(states.WispAI_S0257==true)",
  );
  expect(decodeFrame(h.saved())?.kind).toBe(UPLINK_KIND);
  h.run(`
disk.WispAI_S0257=false
now=.2;timers[.1]()
assert(resets==2 and states.WispAI_S0257==false)
C.Send({type='poll'})
now=.24;timers[.04]()
assert(states.WispAI_S0257==true and #logs==0)
`);
  const frame = decodeFrame(h.saved());
  expect(frame?.kind).toBe(UPLINK_KIND);
  expect(frame?.payload.toString()).toBe('{}');
});

test('flat W2 publication reads each full-frame carrier once and reuses its native state cache', () => {
  const h = transportHarness();
  h.run(`
C.Send({type='poll'})
now=.04;timers[.04]()
assert(stateReads==1152 and saves==1,'one startup downlink baseline precedes the first full-frame publication')
assert(stateChanges>0 and stateChanges<768)
firstChanges=stateChanges
for i=1,128 do assert(states[string.format('WispAI_B%03d',i)],'uplink must never write the downlink B lane')end
C.Send({type='poll'})
now=.08;timers[.04]()
assert(stateReads==1152 and saves==2,'cached publication needs one save and no additional native state reads')
assert(stateChanges>firstChanges and stateChanges-firstChanges<128,'only changed wire sequence and CRC bits need native mutations')
assert(#logs==0)
`);
  expect(decodeFrame(h.saved())?.kind).toBe(UPLINK_KIND);
});

test('a retired host generation cannot consume a slot during the new host session', () => {
  const h = transportHarness();
  h.run("C.Send({type='hello'});timers[.04]()");
  h.control(1, 100);
  h.run("nextRev=1;now=1;timers[.1]();C.chats[1].status='working';assert(loads==1)");
  h.control(2, 101);
  h.run('nextRev=2;now=2;timers[.1]();assert(loads==2)');
  h.control(3, 100);
  h.run('nextRev=3;now=3;timers[.1]();assert(loads==2 and C.rev==2 and #logs==0)');
});

test('an unacknowledged request renews hello with fresh context before retrying its application identity', () => {
  const h = transportHarness();
  h.run(`
C_EncodingUtil.SerializeJSON=function(packet)
 packets[#packets+1]=packet
 return packet.type
end
C.Send({type='say',chat='chat',messageId='retry-me',text='hello'})
now=.04;timers[.04]()
C.characterAcknowledged=7;C.questAcknowledged=9;captures=0
C.CaptureTurn=function()
 assert(C.characterAcknowledged==0 and C.questAcknowledged==0)
 captures=captures+1
 return {characterRevision=12,questRevision=13}
end
now=6;timers[2]()
assert(captures==1 and #packets==3)
assert(packets[2].type=='hello' and packets[2].heartbeat==true)
assert(packets[2].context.characterRevision==12 and packets[2].context.questRevision==13)
assert(packets[3].type=='say' and packets[3].seq==packets[1].seq)
assert(packets[3].messageId=='retry-me' and packets[3].session==packets[1].session)
`);
  const original = decodeFrame(h.saved())!;
  expect(original.payload.toString()).toBe('say');
  h.run('now=6.04;timers[.04]();assert(#logs==0)');
  const handshake = decodeFrame(h.saved())!;
  expect(handshake.payload.toString()).toBe('hello');
  h.run('now=6.08;timers[.04]();assert(#logs==0)');
  const retry = decodeFrame(h.saved())!;
  expect(retry.payload.toString()).toBe('say');
  expect(retry.sequence).not.toBe(original.sequence);
  expect(handshake.sequence).not.toBe(retry.sequence);
});

test('consuming the last bulk helper marks exhaustion and subsequent envelopes clamp the advertised cursor', () => {
  const h = transportHarness();
  h.run("C.Send({type='hello'});timers[.04]()");
  h.run(`
C.slot=1024
states.WispAI_S1024=false;disk.WispAI_S1024=false
refreshes=0
C.Refresh=function()refreshes=refreshes+1 end
`);
  h.control(1);
  h.run(`
nextRev=1;now=1;timers[.1]()
assert(loads==1 and loadedNames[1]=='WispAI_S1024')
assert(C.slot==1025 and C.exhausted==true and refreshes>=1)
assert(states.WispAI_S1024==false and disk.WispAI_S1024==false)
C.Send({type='poll'})
assert(packets[#packets].nextSlot==1024,'cursor must remain within the packet schema, not expose 1025')
assert(#logs==0)
`);
});
