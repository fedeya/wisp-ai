// Deterministic offline replay. Executes real Lua, but all native APIs are stubs.
// The clock is virtual; none of these timings are CPU, FPS or live latency data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { luaJson } from '../../packages/protocol/src/protocol.ts';
import {
  DOWNLINK_KIND,
  UPLINK_KIND,
  MailboxDecoder,
  decodeFrame,
  encodeFrame,
  encodeMessage,
  inflateMessage,
  type MailboxKind,
} from '../../packages/protocol/src/mailbox.ts';
import { prepareDownlink, parseDownlinkAck } from '../../packages/protocol/src/downlink.ts';
import { preferBulkDelivery } from '../../apps/bridge/src/transport.ts';
import { replayFixtures, type ReplayFixture, type ReplaySnapshot } from './replay-fixtures.ts';
import { historicalDecoder } from './historical-reference.ts';

const require = createRequire(new URL('../../addon/package.json', import.meta.url));
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(path.resolve(sourceRoot, file), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const referenceDir =
  process.argv
    .find((value) => value.startsWith('--reference-dir='))
    ?.split('=')
    .slice(1)
    .join('=') || 'runtime/bridge-research';
type Version = 'legacy' | 'pre-opt' | 'optimized';
const { reference: protocolReference, Decoder: HistoricalDecoder } = await historicalDecoder();
const sources = {
  legacy: {
    core: read(referenceDir + '/Core-before-opt.lua'),
    state: read(referenceDir + '/Downlink-before-opt.lua'),
    transport: read(referenceDir + '/Transport-before-v2.lua'),
  },
  'pre-opt': {
    core: read(referenceDir + '/Core-before-opt.lua'),
    state: read(referenceDir + '/Downlink-before-opt.lua'),
    transport: read(referenceDir + '/Transport-before-opt.lua'),
  },
  optimized: {
    core: read('addon/WispAI/Core.lua'),
    state: read('addon/WispAI/Transport/Downlink.lua'),
    transport: read('addon/WispAI/Transport/Transport.lua'),
  },
};

function vm(version: Version) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  function run(code: string) {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  }
  function push(state: unknown, value: unknown) {
    if (value === null || value === undefined) {
      lua.lua_pushnil(state);
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(state, value);
    } else if (typeof value === 'number') {
      lua.lua_pushnumber(state, value);
    } else if (typeof value === 'string') {
      lua.lua_pushstring(state, to_luastring(value));
    } else if (Array.isArray(value)) {
      lua.lua_createtable(state, value.length, 0);
      value.forEach((entry, index) => {
        push(state, entry);
        lua.lua_rawseti(state, -2, index + 1);
      });
    } else {
      lua.lua_createtable(state, 0, Object.keys(value as object).length);
      for (const [key, entry] of Object.entries(value as object)) {
        push(state, entry);
        lua.lua_setfield(state, -2, to_luastring(key));
      }
    }
  }
  function value(state: unknown, at: number): unknown {
    const type = lua.lua_type(state, at);
    if (type === lua.LUA_TNIL) {
      return null;
    }
    if (type === lua.LUA_TBOOLEAN) {
      return lua.lua_toboolean(state, at);
    }
    if (type === lua.LUA_TNUMBER) {
      return lua.lua_tonumber(state, at);
    }
    if (type === lua.LUA_TSTRING) {
      return to_jsstring(lua.lua_tolstring(state, at));
    }
    if (type !== lua.LUA_TTABLE) {
      throw Error('Not JSON');
    }
    const index = lua.lua_absindex(state, at),
      values: Record<string, unknown> = Object.create(null);
    let array = true;
    lua.lua_pushnil(state);
    while (lua.lua_next(state, index)) {
      const key = value(state, -2);
      array &&= typeof key === 'number';
      values[String(key)] = value(state, -1);
      lua.lua_pop(state, 1);
    }
    return array
      ? Array.from({ length: Object.keys(values).length }, (_, i) => values[String(i + 1)])
      : values;
  }
  function callback(name: string, fn: (state: unknown) => number) {
    lua.lua_pushcfunction(L, (state: unknown) => {
      try {
        return fn(state);
      } catch (error) {
        return lauxlib.luaL_error(state, to_luastring(String(error)));
      }
    });
    lua.lua_setglobal(L, to_luastring(name));
  }
  function evalValue(expression: string) {
    run('benchmarkValue=' + expression);
    lua.lua_getglobal(L, to_luastring('benchmarkValue'));
    const result = value(L, -1);
    lua.lua_pop(L, 1);
    return result;
  }
  function set(name: string, data: unknown) {
    push(L, data);
    lua.lua_setglobal(L, to_luastring(name));
  }
  const saved: { atMs: number; bytes: Buffer }[] = [];
  const applied: {
    atMs: number;
    revision: number;
    copyTables: number;
    copyNodes: number;
    textBytes: number;
    final: boolean;
  }[] = [];
  callback('nativeDeserialize', (state) => {
    push(state, JSON.parse(to_jsstring(lua.lua_tolstring(state, 1))));
    return 1;
  });
  callback('nativeSerialize', (state) => {
    lua.lua_pushstring(state, to_luastring(JSON.stringify(value(state, 1))));
    return 1;
  });
  for (const [name, fn] of [
    ['nativeCompress', deflateSync],
    ['nativeDecompress', inflateSync],
  ] as const) {
    callback(name, (state) => {
      const bytes = fn(Buffer.from(lua.lua_tolstring(state, 1)));
      lua.lua_pushlstring(state, bytes, bytes.length);
      return 1;
    });
  }
  callback('nativeSaved', (state) => {
    saved.push({
      atMs: lua.lua_tonumber(state, 1) * 1000,
      bytes: Buffer.from(lua.lua_tolstring(state, 2)),
    });
    return 0;
  });
  callback('nativeApplied', (state) => {
    const data = value(state, 2) as Record<string, unknown>;
    const copy = value(state, 3) as Record<string, number> | null;
    const info = data.benchmark as { textBytes?: number; final?: boolean } | undefined;
    applied.push({
      atMs: lua.lua_tonumber(state, 1) * 1000,
      revision: Number(data.rev),
      copyTables: copy
        ? (copy.deepTables || 0) + (copy.shallowTables || 0)
        : lua.lua_tonumber(state, 4),
      copyNodes: copy ? (copy.deepNodes || 0) + (copy.shallowEntries || 0) : 0,
      textBytes: info?.textBytes || 0,
      final: Boolean(info?.final),
    });
    return 0;
  });
  run(`
now=0;clockTimers={};states={};disk={};counts={save=0,reset=0,read=0,enable=0,disable=0,load=0};cloneCount=0;lastCopyCount=0
bit={bxor=function(a,b)return a~b end,band=function(a,b)return a&b end,rshift=function(a,b)return a>>b end}
function time()return 12345 end
function GetTime()return now end
function GetTimePreciseSec()return now end
function debugprofilestop()return now*1000 end
function UnitGUID()return 'Player-Replay' end
function print()end
function PlaySound()end
DEFAULT_CHAT_FRAME={AddMessage=function()end};SlashCmdList={}
function CreateFrame()return{RegisterEvent=function()end,SetScript=function()end}end
Enum={CompressionMethod={Zlib=1}}
C_EncodingUtil={SerializeJSON=nativeSerialize,DeserializeJSON=nativeDeserialize,CompressString=nativeCompress,DecompressString=nativeDecompress}
C_Timer={}
function C_Timer.NewTicker(period,fn)
 local timer={period=period,at=now+period,fn=fn};clockTimers[#clockTimers+1]=timer
 return{Cancel=function()timer.cancelled=true end}
end
function C_Timer.After(period,fn)clockTimers[#clockTimers+1]={at=now+period,fn=fn}end
function benchmarkStep()
 local nextTimer
 for _,timer in ipairs(clockTimers)do if not timer.cancelled and(not nextTimer or timer.at<nextTimer.at)then nextTimer=timer end end
 assert(nextTimer,'No timer');now=nextTimer.at
 if nextTimer.period then nextTimer.at=nextTimer.at+nextTimer.period else nextTimer.cancelled=true end
 nextTimer.fn()
 assert(not ns.transportStats.error,ns.transportStats.error)
end
for i=1,128 do local n=string.format('WispAI_B%03d',i);states[n]=true;disk[n]=true end
for i=1,1024 do local n=string.format('WispAI_S%04d',i);states[n]=true;disk[n]=true end
C_AddOns={DoesAddOnExist=function()return true end}
C_AddOns.GetAddOnEnableState=function(name)counts.read=counts.read+1;return states[name]and 2 or 0 end
C_AddOns.EnableAddOn=function(name)counts.enable=counts.enable+1;states[name]=true end
C_AddOns.DisableAddOn=function(name)counts.disable=counts.disable+1;states[name]=false end
C_AddOns.ResetAddOns=function()counts.reset=counts.reset+1;for n,v in pairs(disk)do states[n]=v end end
C_AddOns.SaveAddOns=function()
 counts.save=counts.save+1;for n,v in pairs(states)do disk[n]=v end
 local bytes={}
 for byte=0,${version === 'legacy' ? 15 : 95} do
  local v=0
  for p=0,7 do
   local n=${version === 'legacy' ? "string.format('WispAI_B%03d',byte*8+p+1)" : "string.format('WispAI_S%04d',257+byte*8+p)"}
   if states[n]then v=v+2^(${version === 'legacy' ? '7-p' : 'p'})end
  end
  bytes[#bytes+1]=string.char(v)
 end
 nativeSaved(now,table.concat(bytes))
end
C_AddOns.LoadAddOn=function()
 counts.load=counts.load+1
 if payloadJSON then WispAI_Receive(payloadJSON)end
 return true
end
ns={Core = {},
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
`);
  const source = sources[version];
  run(`assert(load(${JSON.stringify(source.core)}))('WispAI',ns)`);
  // Counter only: the saved pre-optimization function is otherwise unchanged.
  const stateSource =
    version === 'optimized'
      ? source.state
      : source.state.replace('local result = {}', 'local result = {}; cloneCount=cloneCount+1');
  run(`assert(load(${JSON.stringify(stateSource)}))('WispAI',ns)`);
  run(`assert(load(${JSON.stringify(source.transport)}))('WispAI',ns)
ns.session='replay';ns.db={drafts={},sound=false};ns.active='benchmark'
local original=ns.Chat.ReceiveSnapshot
ns.Chat.ReceiveSnapshot=function(data)
 local before=ns.rev
 original(data)
 if ns.rev~=before then nativeApplied(now,data,ns.transportStats.downlinkCopy,cloneCount-lastCopyCount);lastCopyCount=cloneCount end
end
ns.Transport.StartTransport()
`);
  return {
    run,
    set,
    evalValue,
    saved,
    applied,
    step() {
      run('benchmarkStep()');
      return Number(evalValue('now')) * 1000;
    },
    write(frame: Buffer) {
      set('benchmarkDiskBytes', [...frame]);
      run(
        `for byte=1,48 do for p=0,7 do local i=(byte-1)*8+p+1;local n=i<=128 and string.format('WispAI_B%03d',i)or string.format('WispAI_S%04d',i-128);disk[n]=math.floor(benchmarkDiskBytes[byte]/2^p)%2==1 end end`,
      );
    },
    payload(snapshot: ReplaySnapshot) {
      set('payloadJSON', JSON.stringify(snapshot));
    },
    clearMeasurements() {
      saved.length = 0;
      applied.length = 0;
      run('counts={save=0,reset=0,read=0,enable=0,disable=0,load=0};cloneCount=0;lastCopyCount=0');
    },
    counts() {
      return evalValue('counts');
    },
    close() {
      lua.lua_close(L);
    },
  };
}

function replay(version: Version, fixture: ReplayFixture, bulkAvailable: boolean) {
  const game = vm(version),
    legacyDecoder = new HistoricalDecoder(),
    decoder = new MailboxDecoder(UPLINK_KIND);
  const kind = (version === 'optimized' ? 4 : DOWNLINK_KIND) as MailboxKind;
  const hostGeneration = 7001;
  let nextSequence = 0,
    consumedSaves = 0,
    now = 0,
    active:
      | {
          snapshot: ReplaySnapshot;
          frames: Buffer[];
          index: number;
          bulk: boolean;
          writtenAt: number;
        }
      | undefined;
  let latest: ReplaySnapshot | undefined, base: ReplaySnapshot | undefined;
  let receivedRevision = 0,
    admittedAt: number | undefined,
    admittedSequence = 1;
  let dataFrames = 0,
    dataBytes = 0,
    controlFrames = 0,
    compactAcks = 0,
    rawAcks = 0,
    publications = 0,
    bulkPayloadBytes = 0;
  let fragmentMs = version === 'optimized' ? 50 : 100,
    bulkMs = 150;
  const writeActive = () => {
    if (!active) {
      return;
    }
    game.write(active.frames[active.index]);
    active.writtenAt = now;
  };
  const startLatest = () => {
    if (active || !latest || latest.rev <= receivedRevision) {
      return;
    }
    const prepared = prepareDownlink(latest, base);
    const bulk =
      bulkAvailable &&
      (version === 'pre-opt'
        ? prepared.body.length > 96
        : preferBulkDelivery(prepared.body.length, {
            fragmentMs,
            bulkMs,
            slotsRemaining: Math.max(0, 1025 - Number(game.evalValue('ns.slot'))),
          }));
    game.payload(latest);
    const frames = bulk
      ? [
          encodeFrame({
            kind,
            flags: 3,
            generation: hostGeneration,
            sequence: nextSequence,
            payload: Buffer.from(JSON.stringify({ r: latest.rev })),
          }),
        ]
      : encodeMessage(prepared.body, kind, hostGeneration, nextSequence, true);
    nextSequence = (nextSequence + frames.length) & 65535;
    active = { snapshot: latest, frames, index: 0, bulk, writtenAt: now };
    if (bulk) {
      controlFrames++;
      bulkPayloadBytes += Buffer.byteLength(luaJson(JSON.stringify(latest)));
    } else {
      dataFrames += frames.length;
      dataBytes += prepared.body.length;
    }
    writeActive();
  };
  const acknowledge = (generation: number, sequence: number, revision: number, resync: boolean) => {
    if (!active) {
      return;
    }
    const frame = decodeFrame(active.frames[active.index])!;
    if (generation !== hostGeneration || sequence !== frame.sequence) {
      return;
    }
    assert.equal(resync, false, 'Replay unexpectedly required a resync');
    const rtt = Math.max(1, now - active.writtenAt);
    if (active.bulk) {
      bulkMs = 0.8 * bulkMs + 0.2 * rtt;
    } else {
      fragmentMs = 0.8 * fragmentMs + 0.2 * rtt;
    }
    if (++active.index < active.frames.length) {
      writeActive();
    } else {
      assert.equal(revision, active.snapshot.rev);
      base = active.snapshot;
      receivedRevision = revision;
      active = undefined;
      startLatest();
    }
  };
  const dispatch = (packet: Record<string, unknown>) => {
    if (packet.type === 'say') {
      admittedAt ??= now;
      admittedSequence = Number(packet.seq);
    }
    const rev = Number(packet.receivedRev || 0);
    if (rev > receivedRevision) {
      receivedRevision = rev;
    }
  };
  const processSaves = () => {
    while (consumedSaves < game.saved.length) {
      const saved = game.saved[consumedSaves++];
      if (version === 'legacy') {
        const packet = legacyDecoder.add(saved.bytes);
        if (packet) {
          dispatch(packet);
        }
      } else {
        const compact = decodeFrame(saved.bytes.subarray(0, 16));
        if (compact?.kind === (3 as MailboxKind)) {
          compactAcks++;
          const final = active && active.index + 1 === active.frames.length;
          acknowledge(
            compact.generation,
            compact.sequence,
            final ? active!.snapshot.rev : receivedRevision,
            Boolean(compact.flags & 1),
          );
        } else {
          const message = decoder.add(saved.bytes);
          if (!message) {
            continue;
          }
          const packet = JSON.parse(inflateMessage(message).toString()) as Record<string, unknown>;
          const ack = parseDownlinkAck(packet);
          if (ack) {
            rawAcks++;
            acknowledge(ack.a[0], ack.a[1], ack.a[2], Boolean(ack.n));
          } else {
            dispatch(packet);
          }
        }
      }
    }
  };
  try {
    // Prime the same host generation and raw baseline with a successful bulk
    // receipt. This models an already connected client with a loaded history.
    game.payload(fixture.seed);
    if (version === 'legacy') {
      game.run("ns.chats={{id='benchmark',status='working'}}");
    } else {
      const frame = encodeFrame({
        kind,
        flags: 3,
        generation: hostGeneration,
        sequence: nextSequence++,
        payload: Buffer.from('{"r":1}'),
      });
      active = { snapshot: fixture.seed, frames: [frame], index: 0, bulk: true, writtenAt: now };
      controlFrames++;
      writeActive();
    }
    for (
      let i = 0;
      i < 5000 && (Number(game.evalValue('ns.rev')) !== 1 || (version !== 'legacy' && active));
      i++
    ) {
      now = game.step();
      processSaves();
    }
    assert.equal(Number(game.evalValue('ns.rev')), 1, 'Failed warm start');
    base = fixture.seed;
    receivedRevision = 1;
    active = undefined;
    latest = undefined;
    const startedAt = now;
    game.run(`ns.slot=${bulkAvailable ? 2 : 1025};ns.chats[1].status='idle'`);
    game.clearMeasurements();
    consumedSaves = 0;
    dataFrames = dataBytes = controlFrames = compactAcks = rawAcks = bulkPayloadBytes = 0;
    game.set('benchmarkPrompt', fixture.prompt);
    game.run(
      "ns.Transport.Send({type='say',chat='benchmark',messageId='benchmark-user',text=benchmarkPrompt})",
    );
    let publishedIndex = 0,
      completed = false,
      blocked = false;
    const finalRevision = fixture.updates.at(-1)!.snapshot.rev;
    for (let i = 0; i < 40000; i++) {
      now = game.step();
      processSaves();
      if (admittedAt !== undefined) {
        while (
          publishedIndex < fixture.updates.length &&
          now - admittedAt >= fixture.updates[publishedIndex].atMs
        ) {
          const update = fixture.updates[publishedIndex++];
          latest = { ...update.snapshot, acks: [admittedSequence] };
          publications++;
          if (version === 'legacy') {
            game.payload(latest);
            bulkPayloadBytes += Buffer.byteLength(luaJson(JSON.stringify(latest)));
          } else {
            startLatest();
          }
        }
      }
      if (version === 'legacy' && !bulkAvailable && game.evalValue('ns.exhausted')) {
        blocked = true;
        break;
      }
      if (publishedIndex === fixture.updates.length && receivedRevision >= finalRevision) {
        completed = true;
        break;
      }
      if (now - startedAt > 60000) {
        break;
      }
    }
    const finalApplied = game.applied.find((entry) => entry.revision === finalRevision);
    const firstApplied = game.applied.find((entry) => entry.textBytes > 0);
    if (!blocked) {
      assert.ok(completed && finalApplied, `${version}/${fixture.id} did not complete`);
      game.run('assert(not ns.transportStats.downlinkError,ns.transportStats.downlinkError)');
    }
    return {
      version,
      bulkAvailable,
      completed,
      blocked,
      virtualClockMs: {
        requestAdmitted: admittedAt === undefined ? null : Math.round(admittedAt - startedAt),
        firstTextApplied: firstApplied ? Math.round(firstApplied.atMs - startedAt) : null,
        finalTextApplied: finalApplied ? Math.round(finalApplied.atMs - startedAt) : null,
        finalRevisionAcknowledged: completed ? Math.round(now - startedAt) : null,
      },
      publications,
      appliedRevisions: game.applied.length,
      responseDataBytes: dataBytes,
      responseDataFrames: dataFrames,
      bulkPayloadBytes,
      controlFrames,
      compactAcks,
      rawAcks,
      nativeCalls: game.counts(),
      copiedTables: game.applied.reduce((sum, entry) => sum + entry.copyTables, 0),
      copiedNodes: game.applied.reduce((sum, entry) => sum + entry.copyNodes, 0),
      copiedTablesByRevision: game.applied.map(({ revision, copyTables }) => ({
        revision,
        copyTables,
      })),
    };
  } finally {
    game.close();
  }
}

const selected = process.argv
  .find((value) => value.startsWith('--fixture='))
  ?.slice('--fixture='.length);
const fixtures = replayFixtures().filter((fixture) => !selected || fixture.id === selected);
assert.ok(fixtures.length, 'Unknown fixture');
const results = fixtures.map((fixture) => {
  const cases = (['legacy', 'pre-opt', 'optimized'] as const).flatMap((version) =>
    [true, false].map((available) => replay(version, fixture, available)),
  );
  process.stderr.write(`Replayed ${fixture.id}\n`);
  return {
    id: fixture.id,
    description: fixture.description,
    releaseOffsetsMs: fixture.updates.map((update) => update.atMs),
    cases,
  };
});
console.log(
  JSON.stringify(
    {
      scope:
        'Offline production Lua replay with real Node JSON/zlib and codecs, stubbed native APIs, virtual timer scheduling and zero native/file/model costs. Text-applied times are not rendered text or native latency. The host stop-and-wait/publication model is emulated; optimized bulk selection calls the production policy.',
      referenceDir,
      historicalProtocol: protocolReference,
      sources: Object.fromEntries(
        Object.entries(sources).map(([version, parts]) => [
          version,
          Object.fromEntries(Object.entries(parts).map(([part, source]) => [part, hash(source)])),
        ]),
      ),
      fixtureSha256: hash(JSON.stringify(replayFixtures())),
      assumptions: [
        'Warm identical history is seeded by one bulk receipt before counters start.',
        'Identical source publication offsets are relative to each decoded request; transport may coalesce revisions.',
        'Legacy no-bulk is a blocked outcome, not a latency measurement.',
        'Pre-opt clone table counts instrument one local clone allocation; optimized counts use production diagnostics.',
      ],
      results,
    },
    null,
    2,
  ),
);
