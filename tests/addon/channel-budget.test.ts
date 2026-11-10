import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  DOWNLINK_HELPERS,
  DOWNLINK_KIND,
  FIRST,
  LAST,
  encodeFrame,
} from '../../packages/protocol/src/mailbox.ts';
const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function transportHarness() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
  lua.lua_pushcfunction(L, () => {
    const revision = lua.lua_tonumber(L, 1);
    const frame = encodeFrame({
      kind: DOWNLINK_KIND,
      flags: FIRST | LAST,
      generation: 17,
      sequence: revision & 65535,
      payload: Buffer.from(JSON.stringify({ r: revision })),
    });
    lua.lua_getglobal(L, to_luastring('disk'));
    for (const [index, name] of DOWNLINK_HELPERS.entries()) {
      lua.lua_pushboolean(L, Boolean(frame[index >> 3] & (1 << (index % 8))));
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_pop(L, 1);
    lua.lua_pushnumber(L, revision);
    lua.lua_setglobal(L, to_luastring('nextRev'));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('publishRevision'));
  run(
    `assert(load(${JSON.stringify(readFileSync('addon/WispAI/Transport/Transport.lua', 'utf8'))}))('WispAI',ns); ns.Transport.StartTransport()`,
  );
  return run;
}

test('idle clients consume no channels, duplicate replies back off, and user actions wake reads', () => {
  const run = transportHarness();
  run(
    `
ns.Transport.Send({ type = "hello" })
timers[.04]()
publishRevision(1)
timers[0.5]()
assert(loads == 1)
for index = 1, 7200 do
    now = now + 0.5
    if index % 120 == 0 then
        timers[60]()
        timers[.04]()
    end
    timers[0.5]()
end
assert(
    loads == 1 and ns.slot == 2,
    "an hour of idle heartbeats must consume zero additional bulk channels"
)
`,
  );
  run(
    `
ns.chats[1].status = "working"
local before = loads
for index = 1, 240 do
    now = now + 0.5
    timers[0.5]()
end
assert(loads == before, "checked duplicate replies must consume zero bulk channels")
local before = loads
ns.Transport.Send({ type = "say", text = "new message" })
timers[.04]()
publishRevision(2)
now=now+.1
timers[0.5]()
assert(loads == before + 1 and ns.rev == 2, "new actions must bypass the backoff immediately")
`,
  );
});

test('startup keeps reading after hello is acknowledged while the agent is still starting', () => {
  const run = transportHarness();
  run(`
ns.Transport.Send({ type = "hello" })
nextConnected = false
timers[.04]()
publishRevision(1)
timers[0.5]()
assert(loads == 1 and not ns.connected)
now = 1
publishRevision(2)
nextConnected = true
timers[0.5]()
assert(loads == 2 and ns.connected, "ready snapshot must be read without another user message")
now = 2
timers[0.5]()
assert(loads == 2, "connected idle clients must stop consuming channels")
`);
});

test('connection does not depend on sound settings or playable audio files', () => {
  const run = transportHarness();
  run(`
function PlaySoundFile()
    error("Audio must not gate transport")
end
ns.Transport.Send({ type = "hello" })
nextConnected = true
timers[.04]()
publishRevision(1)
timers[0.5]()
assert(loads == 1 and ns.connected, "hello must complete with audio unavailable")
`);
});

test('unserializable game results send a small error and retries never repeat the bad payload', () => {
  const run = transportHarness();
  run(`
local serialize = C_EncodingUtil.SerializeJSON
local failures = 0
C_EncodingUtil.SerializeJSON = function(packet)
    if packet.data and packet.data.bad then
        failures = failures + 1
        error('attempted to serialize a table that cannot be represented as a json array or object')
    end
    return serialize(packet)
end
ns.Transport.Send({type='state_result',chat='chat',requestId='quest-5041',data={bad=true}})
assert(#packets==1 and failures==1)
assert(packets[1].requestId=='quest-5041' and packets[1].data.status=='unavailable')
assert(packets[1].data.error:find('Could not encode game result',1,true))
timers[0.04]()
now=6
timers[2]()
assert(#packets==3 and packets[2].type=='hello' and packets[3].type=='state_result' and failures==1, 'retry renews the handshake and contains the error, not the unserializable result')
ns.Transport.Acknowledge({packets[1].seq})
timers[0.04]()
now=12
timers[2]()
assert(#packets==3, 'error results follow ordinary acknowledgement handling')
`);
});

test('failed serialization of a user message does not leave a broken packet in the retry loop', () => {
  const run = transportHarness();
  run(`
local failures=0
C_EncodingUtil.SerializeJSON=function()
    failures=failures+1
    error('serialization failed')
end
assert(not pcall(ns.Transport.Send,{type='say',chat='chat',text='test'}))
now=6
timers[2]()
assert(failures==1)
`);
});

test('message acknowledgements end Sending without discarding optimistic history and cancel queued retries', () => {
  const run = transportHarness();
  run(`
ns.pendingMessages={m={chat='chat',message={text='hello'}}}
ns.Transport.Send({type='say',chat='chat',messageId='m',context={questRevision=2}})
timers[0.04]()
now=6
timers[2]()
local before=#packets
ns.Transport.Acknowledge({1})
assert(ns.pendingMessages.m.acknowledged and ns.pendingMessages.m.message.text=='hello')
assert(ns.questAcknowledged==2 and ns.transportStats.delivery.ms==6000)
timers[0.04]()
now=12
timers[2]()
assert(#packets==before, 'acknowledged queued retries must be removed')
`);
});

test('message confirmation polling starts after transmission and does not inherit the old backoff', () => {
  const run = transportHarness();
  run(`
ns.connected=true
ns.chats[1].status='working'
ns.pendingMessages={m={chat='chat',message={text='hello'}}}
local serialize=C_EncodingUtil.SerializeJSON
C_EncodingUtil.SerializeJSON=function(packet)
    serialize(packet)
    return packet.type=='say' and string.rep('x',200) or '{}'
end
ns.Transport.Send({type='say',chat='chat',messageId='m',text='hello'})
timers[0.5]()
assert(loads==0, 'an ack cannot exist while the message is queued')
now=0.04;timers[0.04]()
now=0.08;timers[0.04]()
timers[0.5]()
assert(loads==0, 'do not consume channels on partial messages')
now=0.12;timers[0.04]()
now=0.3;timers[0.1]()
assert(loads==0,'missing checked readiness must not consume a bulk channel')
now=0.6;publishRevision(1);timers[0.1]()
assert(ns.pendingMessages.m.acknowledged)
local delivery=ns.transportStats.delivery
assert(delivery.frames==3 and delivery.bytes==200 and delivery.retries==0)
assert(delivery.queueMs>=39 and delivery.queueMs<=40)
assert(delivery.transmitMs>=79 and delivery.transmitMs<=80)
assert(delivery.ackMs>=479 and delivery.ackMs<=480)
`);
});

test('confirmed integration reports and delivery telemetry do not bloat subsequent messages', () => {
  const run = transportHarness();
  run(`
local version='1'
local sent={}
ns.Integrations.IntegrationReport=function()return {version=version}end
C_EncodingUtil.SerializeJSON=function(packet)
    if not packet.type then return packet.version end
    sent[#sent+1]=packet
    return '{}'
end
ns.Transport.Send({type='hello'})
assert(sent[1].integrations.version=='1')
ns.Transport.Acknowledge({1})
ns.transportStats.delivery={messageId='old',ms=4000}
ns.Transport.Send({type='say',text='hello'})
assert(sent[2].integrations==nil and sent[2].transport==nil)
version='2'
ns.Transport.Send({type='say',text='changed'})
assert(sent[3].integrations.version=='2', 'changed readiness must travel immediately')
ns.Transport.Send({type='hello',heartbeat=true})
assert(sent[4].integrations.version=='2' and sent[4].transport.delivery.ms==4000, 'heartbeats still refresh readiness and telemetry')
`);
});

test('interactive traffic overtakes unsent polls without interrupting multi-frame packets', () => {
  const run = transportHarness();
  run(`
local sent = {}
C_EncodingUtil.SerializeJSON=function(packet)return packet.type end
C_AddOns.SaveAddOns=function()
    local value=0
    for bit=0,7 do
        if states[string.format('WispAI_S%04d',353+bit)] then value=value+2^bit end
    end
    sent[#sent+1]=string.char(value)
end
ns.Transport.Send({type='poll'})
ns.Transport.Send({type='poll'})
ns.Transport.Send({type='say'})
timers[0.04]()
assert(sent[1]=='s', 'user message must overtake the coalesced polls')
timers[0.04]()
assert(#sent==1, 'the message already carries the current cursor; redundant polls are discarded')
ns.Transport.Send({type='poll'}); ns.Transport.Send({type='poll'})
timers[0.04](); timers[0.04]()
assert(#sent==2 and sent[2]=='p', 'repeated polls coalesce to one')
ns.Transport.Send({type=string.rep('a',200)})
timers[0.04]()
ns.Transport.Send({type='state_result'})
timers[0.04](); timers[0.04](); timers[0.04]()
assert(sent[3]=='a' and sent[4]=='a' and sent[5]=='a' and sent[6]=='s', 'fragments cannot interleave')
`);
});
