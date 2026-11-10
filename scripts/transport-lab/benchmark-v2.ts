// Offline Lua encoder -> helper bits -> Node decoder comparison. Never touches WoW.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { packetSchema } from '../../packages/protocol/src/protocol.ts';
import {
  MailboxDecoder,
  UPLINK_KIND,
  UPLINK_BITS,
  inflateMessage,
} from '../../packages/protocol/src/mailbox.ts';
import { historicalDecoder } from './historical-reference.ts';

const require = createRequire(new URL('../../addon/package.json', import.meta.url));
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const referenceDir =
  process.argv
    .find((value) => value.startsWith('--reference-dir='))
    ?.slice('--reference-dir='.length) || 'runtime/bridge-research';
const baselinePath = referenceDir + '/Transport-before-v2.lua';
const baseline = readFileSync(baselinePath, 'utf8');
const { reference: protocolReference, Decoder: HistoricalDecoder } = await historicalDecoder();
const current = readFileSync(
  new URL('../../addon/WispAI/Transport/Transport.lua', import.meta.url),
  'utf8',
);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const luaBytes = (bytes: Uint8Array) =>
  '"' + Array.from(bytes, (byte) => '\\' + String(byte).padStart(3, '0')).join('') + '"';
function luaSource(text: string) {
  let eq = '=';
  while (text.includes(']' + eq + ']')) {
    eq += '=';
  }
  return '[' + eq + '[' + text + ']' + eq + ']';
}

function exercise(source: string, version: 1 | 2, json: string, compressed: Buffer) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  const expectedFrames = Math.ceil(
    (compressed.length + (version === 1 ? 2 : 0)) / (version === 1 ? 15 : 80),
  );
  run(`
now=0;timers={};frames={};states={};disk={};names={};ids={};counts={enable=0,disable=0,save=0,reset=0,read=0}
bit={band=function(a,b)return a&b end,bor=function(a,b)return a|b end,bxor=function(a,b)return a~b end,bnot=function(a)return ~a end,rshift=function(a,b)return a>>b end,lshift=function(a,b)return a<<b end}
for i=1,128 do names[#names+1]=string.format('WispAI_B%03d',i)end
for i=1,1024 do names[#names+1]=string.format('WispAI_S%04d',i)end
for i,n in ipairs(names)do ids[n]=i;states[n]=true;disk[n]=true end
local function name(id)return type(id)=='number' and names[id] or id end
ns={session='benchmark',
rev=0,
connected=true,
SLOTS=1024,
chats={{status='idle'}},
active='chat',
Core = {},
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
Advice = {}}
function time()return 12345 end
function GetTime()return now end
function GetTimePreciseSec()return now end
function debugprofilestop()return now*1000 end
function UnitGUID()return 'Player-benchmark' end
function print()end
Enum={CompressionMethod={Zlib=1}}
C_EncodingUtil={SerializeJSON=function()return ${luaBytes(Buffer.from(json))} end,CompressString=function()return ${luaBytes(compressed)} end,DeserializeJSON=function()return {r=0}end}
C_Timer={NewTicker=function(s,f)timers[s]=timers[s]or{};table.insert(timers[s],f);return{Cancel=function()end}end,After=function()end,NewTimer=function()return{Cancel=function()end}end}
C_AddOns={
DoesAddOnExist=function(id)return ids[name(id)]~=nil end,
GetNumAddOns=function()return #names end,
GetAddOnName=function(id)return name(id)end,
GetAddOnInfo=function(id)return name(id),name(id),'',true,true,'',false end,
GetAddOnEnableState=function(id)counts.read=counts.read+1;return states[name(id)]and 2 or 0 end,
IsAddOnLoaded=function()return false end,
EnableAddOn=function(id)counts.enable=counts.enable+1;states[name(id)]=true end,
DisableAddOn=function(id)counts.disable=counts.disable+1;states[name(id)]=false end,
ResetAddOns=function()counts.reset=counts.reset+1;for n,v in pairs(disk)do states[n]=v end end,
SaveAddOns=function()
 counts.save=counts.save+1;for n,v in pairs(states)do disk[n]=v end
 local result={}
 for b=0,${version === 1 ? 15 : UPLINK_BITS / 8 - 1} do
  local v=0
  for p=0,7 do
   local n=${version === 1 ? "string.format('WispAI_B%03d',b*8+p+1)" : "string.format('WispAI_S%04d',257+b*8+p)"}
   if states[n]then v=v+2^(${version === 1 ? '7-p' : 'p'})end
  end
  result[#result+1]=string.char(v)
 end
 frames[#frames+1]=table.concat(result)
end,
LoadAddOn=function()error('This uplink benchmark must never load a bulk helper')end
}
assert(load(${luaSource(source)}))('WispAI',ns)
ns.Transport.StartTransport()
${version === 2 ? "assert(ns.transportStats.version==2,'The production Lua did not select v2')" : ''}
counts={enable=0,disable=0,save=0,reset=0,read=0};frames={}
ns.Transport.Send({type='say',chat='chat',messageId='fixture',text='The serializer returns identical benchmark JSON in both cases.'})
for i=1,${expectedFrames} do now=i*.04;for _,f in ipairs(assert(timers[.04],'Missing uplink timer'))do f()end end
`);
  lua.lua_getglobal(L, to_luastring('frames'));
  const frameCount = lua.lua_rawlen(L, -1);
  const frames: Buffer[] = [];
  for (let i = 1; i <= frameCount; i++) {
    lua.lua_rawgeti(L, -1, i);
    frames.push(Buffer.from(lua.lua_tolstring(L, -1)));
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1);
  const counts: Record<string, number> = {};
  lua.lua_getglobal(L, to_luastring('counts'));
  for (const key of ['enable', 'disable', 'save', 'reset', 'read']) {
    lua.lua_getfield(L, -1, to_luastring(key));
    counts[key] = lua.lua_tonumber(L, -1);
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1);
  assert.equal(frames.length, expectedFrames, 'Unexpected production encoder frame count');
  let received: unknown = null;
  if (version === 1) {
    const decoder = new HistoricalDecoder();
    for (const frame of frames) {
      received = decoder.add(frame) || received;
    }
  } else {
    const decoder = new MailboxDecoder(UPLINK_KIND);
    for (const frame of frames) {
      const message = decoder.add(frame);
      if (message) {
        received = packetSchema.parse(JSON.parse(inflateMessage(message).toString('utf8')));
      }
    }
  }
  assert.deepEqual(
    received,
    packetSchema.parse(JSON.parse(json)),
    'Lua-to-Node round trip changed the packet',
  );
  lua.lua_close(L);
  return { frames: frames.length, nominalSerializationMs: frames.length * 40, nativeCalls: counts };
}

function text(seed: number, length: number) {
  let value = seed;
  return Array.from({ length }, () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[value % 63];
  }).join('');
}
const samples = [
  { name: 'short multilingual prompt', text: '¿Qué hago ahora? Frost Nova ❄' },
  {
    name: 'warmed prompt with bounded context',
    text: 'Revisá mi equipo y decime qué cambio.',
    context: { description: text(1, 320) },
  },
  {
    name: 'inspection response',
    type: 'state_result',
    requestId: 'inspect',
    data: { description: text(2, 4096) },
  },
  {
    name: 'large inspection response',
    type: 'state_result',
    requestId: 'inspect-large',
    data: { description: text(3, 16384) },
  },
].map(({ name, ...body }) => {
  const packet = {
    type: 'say',
    chat: 'chat',
    session: 'benchmark',
    seq: 1,
    at: 12345,
    ...body,
  };
  const json = JSON.stringify(packet);
  const compressed = deflateSync(Buffer.from(json));
  const legacy = exercise(baseline, 1, json, compressed);
  const v2 = exercise(current, 2, json, compressed);
  return {
    name,
    jsonBytes: Buffer.byteLength(json),
    compressedBytes: compressed.length,
    legacy,
    v2,
    nativeSaveReductionPercent: Math.round((1 - v2.frames / legacy.frames) * 1000) / 10,
  };
});
console.log(
  JSON.stringify(
    {
      scope:
        'Actual production Lua frame encoders and Node decoders, identical precomputed JSON/zlib body, stubbed client APIs. Each fixture starts a fresh VM/helper bank. Not live CPU/FPS, inference, filesystem or end-to-end timing.',
      baseline: {
        source: baselinePath,
        sha256: sha256(baseline),
      },
      historicalProtocol: protocolReference,
      v2: { source: 'addon/WispAI/Transport/Transport.lua', sha256: sha256(current) },
      nominalPeriodMs: 40,
      samples,
    },
    null,
    2,
  ),
);
