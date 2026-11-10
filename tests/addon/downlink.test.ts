import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';
import { prepareDownlink, parseDownlinkAck } from '../../packages/protocol/src/downlink.ts';
import {
  DOWNLINK_KIND,
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  UPLINK_KIND,
  MailboxDecoder,
  decodeFrame,
  encodeFrame,
  encodeMessage,
  inflateMessage,
} from '../../packages/protocol/src/mailbox.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// Native APIs are stubbed, but JSON/zlib bytes, frame CRCs, production Lua and
// helper bit mapping are real. This is a correctness test, not native FPS data.
function harness(compact = false) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
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
      value.forEach((child, index) => {
        push(state, child);
        lua.lua_rawseti(state, -2, index + 1);
      });
    } else {
      lua.lua_createtable(state, 0, Object.keys(value as object).length);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        push(state, child);
        lua.lua_setfield(state, -2, to_luastring(key));
      }
    }
  }
  function read(state: unknown, at: number): unknown {
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
      throw Error('Not a JSON value');
    }
    const index = lua.lua_absindex(state, at);
    const values: Record<string, unknown> = Object.create(null);
    let array = true;
    lua.lua_pushnil(state);
    while (lua.lua_next(state, index)) {
      const key = read(state, -2);
      array &&= typeof key === 'number';
      values[String(key)] = read(state, -1);
      lua.lua_pop(state, 1);
    }
    if (array) {
      return Array.from({ length: Object.keys(values).length }, (_, i) => values[String(i + 1)]);
    }
    return values;
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
  const snapshots: unknown[] = [];
  const saved: Buffer[] = [];
  callback('nativeDeserialize', (state) => {
    push(state, JSON.parse(to_jsstring(lua.lua_tolstring(state, 1))));
    return 1;
  });
  callback('nativeSerialize', (state) => {
    lua.lua_pushstring(state, to_luastring(JSON.stringify(read(state, 1))));
    return 1;
  });
  callback('nativeCompress', (state) => {
    const result = deflateSync(Buffer.from(lua.lua_tolstring(state, 1)));
    lua.lua_pushlstring(state, result, result.length);
    return 1;
  });
  callback('nativeDecompress', (state) => {
    const result = inflateSync(Buffer.from(lua.lua_tolstring(state, 1)));
    lua.lua_pushlstring(state, result, result.length);
    return 1;
  });
  callback('nativeRecord', (state) => {
    snapshots.push(read(state, 1));
    return 0;
  });
  callback('nativeSaved', (state) => {
    saved.push(Buffer.from(lua.lua_tolstring(state, 1)));
    return 0;
  });
  run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
  run(`
bit={bxor=function(a,b)return a~b end,band=function(a,b)return a&b end,rshift=function(a,b)return a>>b end}
function UnitGUID()return 'Player-Test-GUID' end
function GetTimePreciseSec()return now end
states={};disk={};saves=0;resets=0;stateReads=0;logs={};applications=0
for i=1,128 do local n=string.format('WispAI_B%03d',i);states[n]=true;disk[n]=true end
for i=1,1024 do local n=string.format('WispAI_S%04d',i);states[n]=true;disk[n]=true end
local function check(name,character)
 assert(character=='Player-Test-GUID','native state APIs must select the active character')
 assert(states[name]~=nil,'unknown helper '..tostring(name))
end
C_AddOns.DoesAddOnExist=function(name)return states[name]~=nil end
C_AddOns.GetAddOnEnableState=function(name,character)check(name,character);stateReads=stateReads+1;return states[name]and 2 or 0 end
C_AddOns.EnableAddOn=function(name,character)check(name,character);states[name]=true end
C_AddOns.DisableAddOn=function(name,character)check(name,character);states[name]=false end
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
 nativeSaved(table.concat(bytes))
end
C_EncodingUtil.SerializeJSON=nativeSerialize
C_EncodingUtil.DeserializeJSON=nativeDeserialize
C_EncodingUtil.CompressString=nativeCompress
C_EncodingUtil.DecompressString=nativeDecompress
C.VERSION=1
C.Log=function(text)logs[#logs+1]=tostring(text)end
C.ReceiveSnapshot=function(data)
 if data.rev<=C.rev then return end
 C.RememberDownlink(data)
 C.rev=data.rev;C.connected=data.connected;C.chats=data.chats or {}
 applications=applications+1;displayed=data
 nativeRecord(data)
 if mutateOptimistic then data.chats[1].messages[#data.chats[1].messages+1]={text='optimistic'}end
end
`);
  for (const file of ['Downlink.lua', 'Transport.lua']) {
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + file, 'utf8'))}))('WispAI',C)`,
    );
  }
  run('C.StartTransport();assert(C.reusableDownlink and C.transportStats.mailboxVersion==1)');
  // Establish the outbound session before accepting server publications, as
  // the production login does. Exclude that setup work from per-message counts.
  run(
    "C.Send({type='hello'});for i=1,10 do timers[.04]()end;C.Acknowledge({1});saves=0;resets=0;stateReads=0",
  );
  saved.length = 0;
  function write(frame: Buffer) {
    lua.lua_pushlstring(L, frame, frame.length);
    lua.lua_setglobal(L, to_luastring('diskFrame'));
    run(`
for byte=1,48 do
 local value=diskFrame:byte(byte)
 for position=0,7 do
  local index=(byte-1)*8+position+1
  local name=index<=128 and string.format('WispAI_B%03d',index)or string.format('WispAI_S%04d',index-128)
  disk[name]=math.floor(value/2^position)%2==1
 end
end
`);
  }
  function receive(frame: Buffer, ack = true) {
    write(frame);
    // Allow the production idle receive backoff (500ms) between publications.
    run(
      'now=now+.61;timers[.5]();timers[.1]();timers[.05]();assert(C.transportStats.error==nil,C.transportStats.error)',
    );
    if (ack) {
      run('now=now+.04;timers[.04]();assert(#logs==0,logs[1])');
    }
  }
  function message(envelope: unknown, sequence = 0, generation = 77, ack = true) {
    const body = deflateSync(JSON.stringify(envelope));
    const frames = encodeMessage(
      body,
      compact ? COMPACT_DOWNLINK_KIND : DOWNLINK_KIND,
      generation,
      sequence,
      true,
    );
    for (const frame of frames) {
      receive(frame, ack);
    }
    return frames;
  }
  return {
    run,
    receive,
    write,
    message,
    saved,
    snapshots,
    compactAck: () => decodeFrame(saved.at(-1)!.subarray(0, 16)),
    lastAck() {
      const frame = decodeFrame(saved.at(-1)!);
      expect(frame?.kind).toBe(UPLINK_KIND);
      return parseDownlinkAck(JSON.parse(frame!.payload.toString()));
    },
  };
}

function snapshot(rev: number, text = 'Hola ☀️') {
  return {
    v: 1,
    session: 'game',
    rev,
    connected: true,
    chats: [{ id: 'chat', status: 'working', messages: [{ id: 'm', text }] }],
  };
}

test('negotiated compact acknowledgements touch 128 uplink bits and unchanged reads reuse validated bodies', () => {
  const h = harness(true);
  h.run('C.slot=1025');
  h.message({ r: 1, s: snapshot(1) });
  expect(h.compactAck()).toMatchObject({ kind: COMPACT_ACK_KIND, generation: 77, flags: 0 });
  h.run(
    'stateReads=0;now=now+1;timers[.05]();assert(stateReads==128 and C.transportStats.cachedReads>=1);stateReads=0;now=now+.04;timers[.04]();assert(stateReads==128)',
  );
  expect(h.compactAck()?.kind).toBe(COMPACT_ACK_KIND);
  h.message({ r: 2, b: 99, p: [['s', ['rev'], 2]] }, 100);
  expect(h.compactAck()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 1 });
  h.run('assert(applications==1 and C.rev==1 and C.transportStats.downlinkResyncs==1)');
});

test('compact responses can progress at 50ms while application packets retain their full frame format', () => {
  const h = harness(true);
  const frames = encodeMessage(
    prepareDownlink(snapshot(1)).body,
    COMPACT_DOWNLINK_KIND,
    77,
    0,
    true,
  );
  h.receive(frames[0]);
  for (const frame of frames.slice(1)) {
    h.write(frame);
    h.run('now=now+.051;timers[.05]();now=now+.04;timers[.04]()');
  }
  expect(h.snapshots).toHaveLength(1);
  expect(h.compactAck()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 2 });
  h.run('C.Send({type="hello",heartbeat=true});now=now+1;timers[.04]()');
  expect(decodeFrame(h.saved.at(-1)!)?.kind).toBe(UPLINK_KIND);
});

test('compact delivery progresses on slightly early 50ms callbacks without skipping a fragment', () => {
  const h = harness(true);
  const expected = snapshot(1);
  const frames = encodeMessage(prepareDownlink(expected).body, COMPACT_DOWNLINK_KIND, 77, 0, true);
  expect(frames.length).toBeGreaterThan(1);
  h.write(frames[0]);
  h.run('now=1;timers[.1]();now=1.001;timers[.04]();assert(resets==1)');
  for (let index = 1; index < frames.length; index++) {
    h.write(frames[index]);
    const receivedAt = 1 + index * 0.049;
    h.run(
      `now=${receivedAt};timers[.05]();assert(resets==${index + 1});now=${receivedAt + 0.001};timers[.04]();assert(#logs==0,logs[1])`,
    );
  }
  expect(h.snapshots).toEqual([expected]);
  expect(h.compactAck()).toMatchObject({ kind: COMPACT_ACK_KIND, flags: 2 });
});

test('negotiated compact mode has one receive scheduler instead of competing slow timers', () => {
  const h = harness(true);
  h.message({ r: 1, s: snapshot(1) });
  h.run(`
resets=0
now=now+1
timers[.1]();timers[.5]()
assert(resets==0,'noncompact tickers must not steal a compact receive slot')
timers[.05]()
assert(resets==1)
now=now+.001;timers[.05]()
assert(resets==1,'jitter tolerance must not allow back-to-back reset reads')
assert(#logs==0,logs[1])
`);
});

test('the exhausted bank receives full snapshots and compressed sparse patches without another bulk load', () => {
  const h = harness();
  h.run('C.slot=1025');
  const first = snapshot(1, 'Hola ☀️'.repeat(100));
  const prepared = prepareDownlink(first);
  const initial = encodeMessage(prepared.body, DOWNLINK_KIND, 77, 0, true);
  for (const frame of initial) {
    h.receive(frame);
  }
  const second = snapshot(2, first.chats[0].messages[0].text + ' ¡Listo!');
  const next = prepareDownlink(second, first);
  expect(next.full).toBe(false);
  for (const frame of encodeMessage(next.body, DOWNLINK_KIND, 77, initial.length, true)) {
    h.receive(frame);
  }
  expect(h.snapshots).toEqual([first, second]);
  expect(h.lastAck()).toMatchObject({
    a: [77, initial.length + Math.ceil(next.body.length / 32) - 1, 2],
    b: false,
  });
  h.run('assert(loads==0 and C.slot==1025 and not C.exhausted and applications==2)');
});

test('consuming the final bulk slot switches to reusable delivery without exposing an exhausted UI state', () => {
  const h = harness();
  const first = snapshot(1);
  h.run(`
C.slot=1024;states.WispAI_S1024=false;disk.WispAI_S1024=false
C_AddOns.LoadAddOn=function()
 loads=loads+1
 C.ReceiveSnapshot(nativeDeserialize(${JSON.stringify(JSON.stringify(first))}))
 return true
end
`);
  h.receive(
    encodeFrame({
      kind: DOWNLINK_KIND,
      flags: 3,
      generation: 77,
      sequence: 0,
      payload: Buffer.from('{"r":1}'),
    }),
    false,
  );
  h.run('assert(loads==1 and C.slot==1025 and not C.exhausted and not states.WispAI_S1024)');
  h.run('now=now+.04;timers[.04]()');
  expect(h.lastAck()).toMatchObject({ a: [77, 0, 1], b: false });
  h.message(
    {
      r: 2,
      b: 1,
      p: [
        ['s', ['rev'], 2],
        ['a', ['chats', 0, 'messages', 0, 'text'], '!'],
      ],
    },
    100,
  );
  h.run('assert(loads==1 and C.slot==1025 and not C.exhausted and C.rev==2)');
  expect(h.snapshots).toHaveLength(2);
  expect(h.lastAck()?.n).toBeUndefined();
});

test('a failed optional bulk load asks for a reusable full state and never blocks the session', () => {
  const h = harness();
  h.run("C_AddOns.LoadAddOn=function()loads=loads+1;return nil,'MISSING' end");
  h.receive(
    encodeFrame({
      kind: DOWNLINK_KIND,
      flags: 3,
      generation: 77,
      sequence: 0,
      payload: Buffer.from('{"r":1}'),
    }),
  );
  expect(h.lastAck()).toMatchObject({ a: [77, 0, 0], b: false, n: true });
  h.message({ r: 1, s: snapshot(1) }, 100);
  h.run('assert(loads==1 and C.slot==1 and C.bulkUnavailable and C.rev==1 and not C.exhausted)');
  expect(h.snapshots).toHaveLength(1);
  expect(h.lastAck()?.n).toBeUndefined();
});

test('patches keep an immutable authoritative baseline despite optimistic UI changes', () => {
  const h = harness();
  h.run('C.slot=1025;mutateOptimistic=true');
  const first = snapshot(1);
  h.message({ r: 1, s: first });
  h.message(
    {
      r: 2,
      b: 1,
      p: [
        ['s', ['rev'], 2],
        ['a', ['chats', 0, 'messages', 0, 'text'], ' chau'],
        ['s', ['chats', 0, 'messages', 1], { id: 'm2', text: 'second' }],
        ['d', ['chats', 0, 'messages', 0, 'id']],
        ['l', ['chats', 0, 'messages'], 1],
      ],
    },
    100,
  );
  expect(h.lastAck()?.n).toBeUndefined();
  expect(h.snapshots[1]).toEqual({
    ...snapshot(2),
    chats: [{ id: 'chat', status: 'working', messages: [{ text: 'Hola ☀️ chau' }] }],
  });
  h.message(
    {
      r: 3,
      b: 2,
      p: [
        ['s', ['rev'], 3],
        ['s', ['missing', 'child'], 'invalid'],
      ],
    },
    200,
  );
  expect(h.lastAck()).toMatchObject({ a: [77, expect.any(Number), 2], n: true });
  h.message(
    {
      r: 3,
      b: 2,
      p: [
        ['s', ['rev'], 3],
        ['a', ['chats', 0, 'messages', 0, 'text'], '!'],
      ],
    },
    300,
  );
  expect(h.lastAck()?.n).toBeUndefined();
  h.run("assert(applications==3 and displayed.chats[1].messages[1].text=='Hola ☀️ chau!')");
});

test('a small patch copies changed paths and one UI projection while preserving a large canonical history', () => {
  const h = harness();
  const first = {
    ...snapshot(1),
    chats: Array.from({ length: 4 }, (_, chat) => ({
      id: 'chat-' + chat,
      status: 'working',
      messages: Array.from({ length: 250 }, (_, index) => ({
        id: 'message-' + index,
        text: `History ${chat}/${index}: está listo ☀️`,
      })),
    })),
  };
  h.run(`
mutateOptimistic=true
sourceEnvelope=nativeDeserialize(${JSON.stringify(JSON.stringify({ r: 1, s: first }))})
C.ApplyDownlink(sourceEnvelope)
local stats=C.transportStats.downlinkCopy
assert(stats.phase=='full' and stats.committed and stats.shallowTables==0)
fullTables=stats.deepTables
assert(fullTables>1000,'fixture must exercise a large history')
sourceEnvelope.s.chats[2].messages[1].text='external mutation'
C.ApplyDownlink({r=2,b=1,p={
 {'s',{'rev'},2},
 {'a',{'chats',3,'messages',249,'text'},' one'},
 {'a',{'chats',3,'messages',249,'text'},' two'}
}})
local copies=C.transportStats.downlinkCopy
assert(copies.phase=='patch' and copies.committed)
assert(copies.deepTables==fullTables,'the mutable UI needs exactly one full projection')
assert(copies.shallowTables<=6,'the canonical candidate detaches only changed ancestors')
assert(copies.deepTables+copies.shallowTables<fullTables*1.01,'a tiny patch must avoid a second history copy')
assert(#displayed.chats[1].messages==251,'optimistic UI state remains separate from canonical history')
`);
  expect(h.snapshots).toHaveLength(2);
  const expected = structuredClone(first);
  expected.rev = 2;
  expected.chats[3].messages[249].text += ' one two';
  expect(h.snapshots[1]).toEqual(expected);
});

test('a later invalid operation rolls back nested copy-on-write changes and leaves the old base usable', () => {
  const h = harness();
  h.run(`
C.ApplyDownlink(nativeDeserialize(${JSON.stringify(JSON.stringify({ r: 1, s: snapshot(1) }))}))
local ok=pcall(C.ApplyDownlink,{r=2,b=1,p={
 {'s',{'rev'},2},
 {'a',{'chats',0,'messages',0,'text'},' BAD'},
 {'s',{'missing','child'},'invalid'}
}})
assert(not ok and C.rev==1 and applications==1)
assert(not C.transportStats.downlinkCopy.committed)
C.ApplyDownlink({r=2,b=1,p={
 {'s',{'rev'},2},
 {'a',{'chats',0,'messages',0,'text'},' GOOD'}
}})
assert(displayed.chats[1].messages[1].text=='Hola ☀️ GOOD')
`);
  expect(h.snapshots).toHaveLength(2);
});

test('a receiver failure clears the prepared projection and does not commit a new patch base', () => {
  const h = harness();
  h.run(`
C.ApplyDownlink(nativeDeserialize(${JSON.stringify(JSON.stringify({ r: 1, s: snapshot(1) }))}))
local original=C.ReceiveSnapshot
C.ReceiveSnapshot=function(data)C.RememberDownlink(data);error('UI receiver failed')end
assert(not pcall(C.ApplyDownlink,{r=2,b=1,p={{'s',{'rev'},2}}}))
assert(C.rev==1 and not C.transportStats.downlinkCopy.committed)
C.ReceiveSnapshot=original
C.ApplyDownlink({r=2,b=1,p={{'s',{'rev'},2},{'a',{'chats',0,'messages',0,'text'},'!'}}})
assert(C.rev==2 and displayed.chats[1].messages[1].text=='Hola ☀️!')
`);
  expect(h.snapshots).toHaveLength(2);
});

test('external bulk snapshots keep one defensive canonical copy before UI or caller mutation', () => {
  const h = harness();
  h.run(`
local bulk=nativeDeserialize(${JSON.stringify(JSON.stringify(snapshot(1)))})
C.ReceiveSnapshot(bulk)
local stats=C.transportStats.downlinkCopy
assert(stats.phase=='bulk' and stats.committed and stats.shallowTables==0)
bulk.chats[1].messages[1].text='mutated bulk projection'
C.ApplyDownlink({r=2,b=1,p={{'s',{'rev'},2},{'a',{'chats',0,'messages',0,'text'},'!'}}})
assert(displayed.chats[1].messages[1].text=='Hola ☀️!')
`);
  expect(h.snapshots).toHaveLength(2);
});

test('a damaged fragment waits for retransmission and a sequence gap requests a complete resync', () => {
  const h = harness();
  h.run('C.slot=1025');
  const frames = encodeMessage(prepareDownlink(snapshot(1)).body, DOWNLINK_KIND, 77, 0, true);
  expect(frames.length).toBeGreaterThan(2);
  for (const frame of frames.slice(0, -1)) {
    h.receive(frame);
  }
  const corrupt = Buffer.from(frames.at(-1)!);
  corrupt[15] ^= 1;
  const before = h.saved.length;
  h.receive(corrupt);
  expect(h.saved).toHaveLength(before);
  expect(h.snapshots).toHaveLength(0);
  h.receive(frames.at(-1)!);
  expect(h.snapshots).toHaveLength(1);
  const gap = encodeMessage(prepareDownlink(snapshot(2)).body, DOWNLINK_KIND, 77, 50, true);
  h.receive(gap[0]);
  h.receive(gap.at(-1)!);
  expect(h.lastAck()).toMatchObject({ a: [77, 50 + gap.length - 1, 1], n: true });
  expect(h.snapshots).toHaveLength(1);
  h.message({ r: 2, s: snapshot(2) }, 100);
  expect(h.snapshots).toHaveLength(2);
  expect(h.lastAck()?.n).toBeUndefined();
});

test('duplicate final frames reacknowledge lost ACKs without applying twice or polling forever while idle', () => {
  const h = harness();
  const state = { ...snapshot(1), chats: [{ id: 'chat', status: 'idle', messages: [] }] };
  const frames = h.message({ r: 1, s: state });
  const expected = h.lastAck();
  const saved = h.saved.length;
  h.receive(frames.at(-1)!);
  expect(h.saved).toHaveLength(saved + 1);
  expect(h.lastAck()).toEqual(expected);
  expect(h.snapshots).toHaveLength(1);
  h.run('for i=1,100 do now=now+.11;timers[.1]();timers[.04]()end;stoppedResets=resets');
  h.run('for i=1,100 do now=now+.11;timers[.1]();timers[.04]()end;assert(resets==stoppedResets)');
});

test('a host restart invalidates the patch base and retired generations cannot overwrite newer state', () => {
  const h = harness();
  h.message({ r: 1, s: snapshot(1) }, 0, 100);
  h.message({ r: 2, b: 1, p: [['s', ['rev'], 2]] }, 0, 101);
  expect(h.lastAck()?.n).toBe(true);
  expect(h.snapshots).toHaveLength(1);
  h.run('assert(C.rev==0)');
  h.message({ r: 1, s: snapshot(1) }, 100, 101);
  expect(h.snapshots).toHaveLength(2);
  h.message({ r: 3, s: snapshot(3) }, 200, 100);
  expect(h.snapshots).toHaveLength(2);
  h.run('assert(C.rev==1 and loads==0)');
});

test('addon settings pause both reusable reads and ACK saves without discarding pending user edits', () => {
  const h = harness();
  const frames = encodeMessage(prepareDownlink(snapshot(1)).body, DOWNLINK_KIND, 77, 0, true);
  h.run('AddonList={IsShown=function()return true end};states.WispAI_S0257=false');
  h.receive(frames[0]);
  h.run('assert(saves==0 and resets==0 and states.WispAI_S0257==false)');
  h.run('AddonList=nil');
  for (const frame of frames) {
    h.receive(frame);
  }
  expect(h.snapshots).toHaveLength(1);
  expect(h.lastAck()?.n).toBeUndefined();
});

test('incoming data and its ACK wait for the current multipart uplink to finish', () => {
  const h = harness();
  const text = Array.from({ length: 160 }, (_, i) => 'value-' + i.toString(36)).join('|');
  h.run(`C.Send({type='say',chat='chat',text=${JSON.stringify(text)}});now=.04;timers[.04]()`);
  const firstUplink = decodeFrame(h.saved[0])!;
  expect(firstUplink.flags & 2).toBe(0);
  const data = encodeMessage(prepareDownlink(snapshot(1)).body, DOWNLINK_KIND, 77, 0, true);
  h.receive(data[0], false);
  h.run('assert(resets==0)');
  for (let i = 0; i < 20; i++) {
    if (decodeFrame(h.saved.at(-1)!)!.flags & 2) {
      break;
    }
    h.run('now=now+.04;timers[.04]()');
  }
  const decoder = new MailboxDecoder(UPLINK_KIND);
  let complete;
  for (const frame of h.saved) {
    complete = decoder.add(frame) || complete;
  }
  expect(JSON.parse(inflateMessage(complete!).toString()).text).toBe(text);
  for (const frame of data) {
    h.receive(frame);
  }
  expect(h.snapshots).toHaveLength(1);
  expect(h.lastAck()?.n).toBeUndefined();
});

test('more than 1024 real revisions reuse the same exhausted helper bank without LoadAddOn', () => {
  const h = harness();
  h.run('C.slot=1025');
  let sequence = 65530;
  for (let rev = 1; rev <= 1025; rev++) {
    const state = { v: 1, session: 'game', rev, connected: true };
    const frames = h.message({ r: rev, s: state }, sequence, 77, false);
    sequence = (sequence + frames.length) & 65535;
    h.run('now=now+.04;timers[.04]();assert(#logs==0,logs[1])');
  }
  expect(h.snapshots).toHaveLength(1025);
  expect(h.lastAck()).toMatchObject({ a: [77, (sequence - 1) & 65535, 1025], b: false });
  h.run(
    'assert(C.rev==1025 and applications==1025 and C.slot==1025 and loads==0 and not C.exhausted)',
  );
}, 120000);
