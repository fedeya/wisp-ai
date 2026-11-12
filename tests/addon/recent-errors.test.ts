import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../../apps/bridge/src/agent-server.ts';
import { newChat } from '../../apps/bridge/src/chat-lifecycle.ts';
import { CapabilitySettings } from '../../apps/bridge/src/capabilities.ts';
import { dynamicEvaluate } from '../node_modules/eve/dist/src/dynamic/definition.js';
import definition from '../../apps/agent/agent/tools/wow__inspect_game_errors.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function fixture(baseline = false) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  const read = (index: number): unknown => {
    const at = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, at)) {
      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tolstring(L, at));
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, at);
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, at);
      case lua.LUA_TTABLE: {
        const object: Record<string, unknown> = {};
        lua.lua_pushnil(L);
        while (lua.lua_next(L, at)) {
          object[String(read(-2))] = read(-1);
          lua.lua_pop(L, 1);
        }
        const keys = Object.keys(object);
        return keys.length && keys.every((key, i) => key === String(i + 1))
          ? keys.map((key) => object[key])
          : object;
      }
      default:
        return null;
    }
  };
  lua.lua_pushjsfunction(L, () => {
    lua.lua_pushstring(L, to_luastring(JSON.stringify(read(1))));
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('serializeJSON'));
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(`
    local create = CreateFrame
    CreateFrame = function(...)
      local frame = create(...)
      frame.events = {}
      frame.RegisterEvent = function(self, name) self.events[name] = true end
      frame.UnregisterEvent = function(self, name) self.events[name] = nil end
      if frame.kind == 'Button' then
        local font = frame:CreateFontString()
        frame.GetFontString = function() return font end
        local setText = frame.SetText
        frame.SetText = function(self, text) setText(self, text); font:SetText(text) end
      end
      return frame
    end
    now = 10
    GetTime = function() return now end
    time = function() return 1700000000 end
    UnitName = function() return 'Synthetic' end
    UnitGUID = function() return 'synthetic-character' end
    UnitClass = function() return 'Mage', 'MAGE' end
    GetBuildInfo = function() return 'synthetic', '1' end
    GetRealmName = function() return 'Fixture' end
    UnitLevel = function() return 20 end
    UnitRace = function() return 'Human', 'Human' end
    UnitFactionGroup = function() return 'Alliance' end
    GetMoney = function() return 0 end
    UnitXP = function() return 0 end
    UnitXPMax = function() return 1 end
    C_Map = {GetBestMapForUnit = function() return nil end}
    GetZoneText = function() return 'Synthetic zone' end
    GetSubZoneText = function() return '' end
    C_QuestLog = {GetNumQuestLogEntries = function() return 0 end}
    timers = {}
    C_Timer = { After = function(delay, fn) timers[#timers+1] = {delay=delay,fn=fn} end,
      NewTimer = function(delay, fn)
      local timer = { delay=delay, fn=fn, Cancel=function(self) self.cancelled=true end }
      timers[#timers+1] = timer
      return timer
    end }
    C_EncodingUtil = { SerializeJSON = serializeJSON }
    issecretvalue = function(v) return type(v) == 'table' and v.secret == true end
    ns = { db = { drafts = { ordinary = 'Keep my normal draft' } },
      chats = {{ id = 'ordinary', status = 'idle', messages = {} }}, active = 'ordinary',
      session = 'fixture', pendingMessages = {}, pendingChats = {}, workStarted = {},
      deletedChats = {}, requestsDone = {}, capabilityPending = {} }
    sends = {}
  `);
  const load = (file: string) =>
    run(
      `assert(load(${JSON.stringify(readFileSync(`addon/WispAI/${file}.lua`, 'utf8'))}))('WispAI', ns)`,
    );
  for (const file of [
    'Namespace',
    'Shared/Numbers',
    'Shared/Text',
    'Character/Capture',
    'Character/RecentErrors',
    'Character/Inspect',
    'UI/Widgets',
    ...(baseline ? [] : ['UI/RecentErrors']),
    'Chat/State',
    'Chat/Snapshot',
  ]) {
    load(file);
  }
  run(`
    ns.Transport.Send = function(packet) sends[#sends+1] = packet end
    ns.Transport.Acknowledge = function() end
    ns.VERSION, ns.rev = 1, 0
    ns.UI.Refresh = function() end
    ns.draft = CreateFrame('EditBox')
    ns.draft:SetText('Keep my normal draft')
    function event(name, ...)
      for _, frame in ipairs(UI_TEST.widgets) do
        if frame.events and frame.events[name] and frame.scripts.OnEvent then frame.scripts.OnEvent(frame, name, ...) end
      end
    end
  `);
  return {
    run,
    load,
    value: (name: string) => {
      lua.lua_getglobal(L, to_luastring(name));
      const value = read(-1);
      lua.lua_pop(L, 1);
      return value;
    },
    close: () => lua.lua_close(L),
  };
}

test('production Inspect admits the recent-notice reader', () => {
  const f = fixture(true);
  try {
    f.run(
      `assert(ns.Character.Inspect({kind='game_errors',args={requested=true}}).status == 'available', 'production Inspect has no recent-notice route')`,
    );
  } finally {
    f.close();
  }
});

test('latest delivery governs retention, wire clipping and newest-first UI order for repeated notices', () => {
  const f = fixture();
  try {
    f.run(`
      ns.RecentErrors.SetEnabled(true)
      event('UI_ERROR_MESSAGE',1,'Synthetic A')
      local id = ns.RecentErrors.Read().records[1].id
      for i=2,30 do now=10+i; event('UI_ERROR_MESSAGE',i,'Synthetic '..i) end
      now=41; event('UI_ERROR_MESSAGE',1,'Synthetic A')
      local last = ns.RecentErrors.Read().records[30]
      assert(last.id == id, 'freshest repeated A must be newest in reader order')
      assert(last.firstAge == 31 and last.latestAge == 0 and last.count == 2)
      now=42; event('UI_ERROR_MESSAGE',31,'Synthetic C')
      local data = ns.RecentErrors.Read()
      assert(data.records[1].errorType == 3 and data.records[29].id == id and data.evicted == 1)
      ns.UI.RecentErrors.Open()
      local rows = {}
      for _, widget in ipairs(UI_TEST.widgets) do if widget.id then rows[#rows+1] = widget end end
      assert(rows[1].id == data.records[30].id and rows[2].id == id)
      assert(ns.UI.RecentErrors.Select(id))
      ns.UI.RecentErrors.Explain()
      assert(UI_TEST.frames.WispAIErrorQuestion:GetText():find('Synthetic A',1,true))
      assert(#sends == 0)
      local serialize = C_EncodingUtil.SerializeJSON
      C_EncodingUtil.SerializeJSON = function(result) return string.rep('x',1000+#result.data.records*1024) end
      local result = ns.Character.Inspect({kind='game_errors',args={requested=true}})
      assert(result.data.wireOmitted > 0 and result.data.records[#result.data.records-1].id == id)
      C_EncodingUtil.SerializeJSON = serialize
    `);
  } finally {
    f.close();
  }
});

test('local-review rows constrain long ASCII/localized text and the question remains scrollable without sending', () => {
  const f = fixture();
  try {
    f.run(`
      ns.RecentErrors.SetEnabled(true)
      event('UI_ERROR_MESSAGE',1,string.rep('W',500))
      ns.UI.RecentErrors.Open()
      local popup = UI_TEST.frames.WispAIRecentErrors
      assert(popup:GetWidth() == 420 and popup:GetHeight() == 310)
      local function rows()
        local out = {}
        for _, widget in ipairs(UI_TEST.widgets) do if widget.id then out[#out+1] = widget end end
        return out
      end
      assert(#rows() == 1)
      event('UI_ERROR_MESSAGE',2,string.rep('界',170))
      event('UI_ERROR_MESSAGE',3,'Synthetic newest')
      local list = rows()
      assert(#list == 3)
      for _, row in ipairs(list) do
        local font = row:GetFontString()
        assert(font:GetWidth() == 372 and font:GetHeight() == 18, 'actual button FontString must be bounded')
        assert(font:GetUnboundedStringWidth() <= 372, 'long row preview must fit its text region')
      end
      list[2].scripts.OnClick(list[2])
      ns.UI.RecentErrors.Explain()
      local editor = UI_TEST.frames.WispAIErrorQuestion
      local scroll = editor:GetParent()
      assert(editor:GetWidth() == 366 and scroll:GetHeight() == 42 and scroll.clipsChildren)
      assert(editor:GetText():find('界',1,true))
      -- Emulate native multiline growth; the fixture does not establish real font rendering.
      editor:SetHeight(300)
      editor.scripts.OnTextChanged(editor)
      editor.scripts.OnCursorChanged(editor,0,-260,1,16)
      assert(scroll:GetVerticalScroll() == 234)
      editor.scripts.OnCursorChanged(editor,0,0,1,16)
      assert(scroll:GetVerticalScroll() == 0)
      local copy = ''
      for _, widget in ipairs(UI_TEST.widgets) do copy=copy..widget:GetText()..'\\n' end
      assert(copy:find('Ages at refresh',1,true) and copy:find('Wheel list',1,true))
      assert(copy:find('not edits',1,true) and copy:find('Unsent edits stay local',1,true))
      assert(not copy:find('Refresh / scroll list',1,true) and #sends == 0)
    `);
  } finally {
    f.close();
  }
});

test('bounds, secret-before-operations, expiry and local privacy survive real lifecycle handlers', () => {
  const f = fixture();
  try {
    f.run(`
      ns.RecentErrors.SetEnabled(true)
      local poison = setmetatable({secret=true}, {
        __tostring=function() error('secret coercion') end,
        __eq=function() error('secret comparison') end,
        __lt=function() error('secret comparison') end
      })
      event('UI_ERROR_MESSAGE', poison, poison)
      event('UI_ERROR_MESSAGE', 1, 5)
      for i=1,31 do event('UI_ERROR_MESSAGE', i, 'notice '..i) end
      local data = ns.RecentErrors.Read()
      assert(#data.records == 30 and data.evicted == 1 and data.omitted == 2)
      event('UI_ERROR_MESSAGE', 32, string.rep('é',257))
      data = ns.RecentErrors.Read()
      local last = data.records[#data.records]
      assert(#last.text == 512 and last.truncated)
      -- Same clipped prefix is not evidence of equal complete messages.
      event('UI_ERROR_MESSAGE', 32, string.rep('é',257)..'different')
      assert(ns.RecentErrors.Read().records[30].count == 1)
      ns.UI.RecentErrors.Open()
      ns.UI.RecentErrors.Select(last.id)
      ns.UI.RecentErrors.Explain()
      local editor = UI_TEST.frames.WispAIErrorQuestion
      assert(editor:GetText() ~= '')
      ns.Chat.ReceiveSnapshot({v=1,session='fixture',rev=1,connected=true,
        chats={{id='ordinary',status='idle',messages={}}}})
      assert(editor:GetText() ~= '')
      assert(ns.draft:GetText() == 'Keep my normal draft')
      local db = C_EncodingUtil.SerializeJSON(ns.db)
      assert(not db:find('notice',1,true) and not db:find('é',1,true))
      assert(#sends == 0)
      now = 131
      for _, timer in ipairs(timers) do if not timer.cancelled then timer.fn() end end
      assert(#ns.RecentErrors.Read().records == 0 and editor:GetText() == '')
      assert(ns.RecentErrors.Read().expired == 30)
      event('UI_ERROR_MESSAGE', 5, 'private logout sample')
      ns.UI.RecentErrors.Select(ns.RecentErrors.Read().records[1].id)
      ns.UI.RecentErrors.Explain()
      event('PLAYER_LOGOUT')
      assert(not ns.RecentErrors.Read().enabled and editor:GetText() == '')
      ns.RecentErrors.SetEnabled(true)
      event('UI_ERROR_MESSAGE', 5, 'private character sample')
      UnitGUID = function() return 'another-synthetic-character' end
      event('PLAYER_ENTERING_WORLD')
      assert(not ns.RecentErrors.Read().enabled and #ns.RecentErrors.Read().records == 0)
      assert(ns.db.drafts.ordinary == 'Keep my normal draft' and #sends == 0)
    `);
  } finally {
    f.close();
  }
});

test('whole Inspect serialization budget includes escaped text and shared metadata', () => {
  const f = fixture();
  try {
    f.run(`
      ns.RecentErrors.SetEnabled(true)
      for i=1,30 do event('UI_ERROR_MESSAGE', i, string.rep(string.char(1),512)) end
      local result = ns.Character.Inspect({kind='game_errors',args={requested=true}})
      assert(#C_EncodingUtil.SerializeJSON(result) <= 24576)
      assert(result.data.wireOmitted > 0 and #result.data.records > 0)
      assert(result.character == 'Synthetic' and result.capturedAt == 1700000000)
      assert(result.data.clipped == 0)
    `);
  } finally {
    f.close();
  }
});

test('automatic context, snapshot restores and actual diagnostics omit local review while ordinary drafts persist', () => {
  const f = fixture();
  try {
    f.run(`
      logs = {}
      SlashCmdList = {}
      DEFAULT_CHAT_FRAME = {AddMessage=function(_, text) logs[#logs+1]=text end}
      WispAIDB = ns.db
    `);
    f.load('Core');
    f.run(`
      event('ADDON_LOADED','WispAI')
      ns.slot = 0
      ns.RecentErrors.SetEnabled(true)
      event('UI_ERROR_MESSAGE', 42, 'PRIVATE-SYNTHETIC-NOTICE')
      ns.UI.RecentErrors.Open()
      ns.UI.RecentErrors.Select(ns.RecentErrors.Read().records[1].id)
      ns.UI.RecentErrors.Explain()
      local editor = UI_TEST.frames.WispAIErrorQuestion
      assert(editor:GetText():find('PRIVATE-SYNTHETIC-NOTICE',1,true))
      assert(not C_EncodingUtil.SerializeJSON(ns.Character.CaptureTurn()):find('PRIVATE-SYNTHETIC-NOTICE',1,true))
      ns.connected = true
      event('QUEST_LOG_UPDATE')
      for _, timer in ipairs(timers) do if timer.delay == 0.5 then timer.fn() end end
      SlashCmdList.WISPAI('diag')
      assert(#logs == 2)
      assert(not C_EncodingUtil.SerializeJSON(logs):find('PRIVATE-SYNTHETIC-NOTICE',1,true))
      assert(not C_EncodingUtil.SerializeJSON(sends):find('PRIVATE-SYNTHETIC-NOTICE',1,true))
      assert(not C_EncodingUtil.SerializeJSON(WispAIDB):find('PRIVATE-SYNTHETIC-NOTICE',1,true))
      ns.UI.Refresh = ns.UI.RecentErrors.Refresh
      ns.Chat.ReceiveSnapshot({v=1, session=ns.session, rev=1, connected=true,
        activeChat='ordinary',chats={{id='ordinary',status='idle',messages={}}}})
      assert(ns.draft:GetText() == 'Keep my normal draft')
      assert(editor:GetText() == '')
      ns.Chat.Select('ordinary')
      assert(WispAIDB.drafts.ordinary == 'Keep my normal draft')
      ns.UI.RecentErrors.Select(ns.RecentErrors.Read().records[1].id)
      ns.UI.RecentErrors.Explain()
      UI_TEST.frames.WispAIRecentErrors:SetSize(420,310)
      ns.UI.RecentErrors.Refresh()
      assert(editor:GetText() ~= '')
      ns.RecentErrors.SetEnabled(false)
      assert(editor:GetText() == '' and WispAIDB.drafts.ordinary == 'Keep my normal draft')
    `);
  } finally {
    f.close();
  }
  const reloaded = fixture();
  try {
    reloaded.run(
      `assert(not ns.RecentErrors.Read().enabled and #ns.RecentErrors.Read().records == 0)`,
    );
  } finally {
    reloaded.close();
  }
});

test('actual deferred tool uses authenticated Inspect route and production snapshot/reader; gates deny automatic access', async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp065-route-'));
  const previous = {
    file: process.env.WOW_CAPABILITIES_FILE,
    url: process.env.WOW_BRIDGE_URL,
    token: process.env.WOW_BRIDGE_TOKEN,
  };
  const settings = new CapabilitySettings(path.join(directory, 'choices.json'));
  settings.agentFile = path.join(directory, 'agent.json');
  const chat = newChat('ordinary', 'fixture');
  chat.eveId = 'eve-fixture';
  chat.status = 'working';
  let transport = 'fixture';
  let reads = 0;
  const server = createServer(
    createAgentHandler({
      token: 'synthetic-token',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: settings,
      pending: {
        request: async (request: { inspection: unknown }) => {
          reads++;
          expect(request.inspection).toEqual({ kind: 'game_errors', args: { requested: true } });
          f.run(`ns.Chat.ReceiveSnapshot({v=1,session='fixture',rev=${reads},connected=true,
        requests={{id='read-${reads}',chat='ordinary',inspection={kind='game_errors',args={requested=true}}}}})
        response = sends[#sends].data`);
          return f.value('response');
        },
      },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  try {
    await settings.publish();
    process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.WOW_BRIDGE_URL = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    process.env.WOW_BRIDGE_TOKEN = 'synthetic-token';
    const resolved = (await dynamicEvaluate(definition as never)({} as never)) as {
      deferred: boolean;
      execute: (input: { requested: true }, ctx: unknown) => Promise<unknown>;
    };
    expect(resolved.deferred).toBe(true);
    const call = () =>
      resolved.execute(
        { requested: true },
        { session: { id: chat.eveId }, abortSignal: new AbortController().signal },
      );
    process.env.WOW_BRIDGE_TOKEN = 'wrong';
    await expect(call()).rejects.toThrow('Forbidden');
    process.env.WOW_BRIDGE_TOKEN = 'synthetic-token';
    transport = 'other';
    await expect(call()).rejects.toThrow('No active connection');
    transport = 'fixture';
    chat.proactive = true;
    await expect(call()).rejects.toThrow('Automatic suggestions');
    chat.proactive = false;
    chat.status = 'idle';
    await expect(call()).rejects.toThrow('No active connection');
    chat.status = 'working';
    settings.availability.set('tool:inspect_game_errors', {
      available: false,
      status: 'unavailable',
    });
    await expect(call()).rejects.toThrow('disabled');
    expect(reads).toBe(0);
    settings.availability.delete('tool:inspect_game_errors');
    f.run(
      `ns.RecentErrors.SetEnabled(true); event('UI_ERROR_MESSAGE',42,'Synthetic: missing reagent')`,
    );
    expect(await call()).toMatchObject({
      status: 'available',
      data: { enabled: true, records: [{ text: 'Synthetic: missing reagent' }] },
    });
    expect(reads).toBe(1);
  } finally {
    for (const [key, value] of Object.entries({
      WOW_CAPABILITIES_FILE: previous.file,
      WOW_BRIDGE_URL: previous.url,
      WOW_BRIDGE_TOKEN: previous.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('documented UI_ERROR_MESSAGE tuple reaches real capture, Inspect and memory-only editable review', () => {
  const f = fixture();
  try {
    f.run(`
      -- Source-derived synthetic tuple, not a native readability sample.
      event('UI_ERROR_MESSAGE', 42, 'Synthetic: missing reagent')
      assert(#ns.Character.Inspect({kind='game_errors', args={}}).data.records == 0)
      ns.UI.RecentErrors.Open()
      local function click(text)
        for _, widget in ipairs(UI_TEST.widgets) do
          if widget.kind == 'Button' and widget:GetText():find(text,1,true) then
            widget.scripts.OnClick(widget)
            return
          end
        end
        error('Missing real UI button: '..text)
      end
      click('Enable local capture')
      event('UI_ERROR_MESSAGE', 42, 'Synthetic: missing reagent')
      event('UI_ERROR_MESSAGE', 42, 'Synthetic: missing reagent')
      event('UI_ERROR_MESSAGE', {secret=true}, 'SECRET MUST NOT ENTER')
      event('UI_ERROR_MESSAGE', 7, {secret=true})
      local result = ns.Character.Inspect({kind='game_errors', args={}})
      assert(result.status == 'available')
      assert(#result.data.records == 1)
      assert(result.data.records[1].text == 'Synthetic: missing reagent')
      assert(result.data.records[1].count == 2)
      assert(result.data.omitted == 2)
      click('Synthetic: missing reagent')
      click('Explain')
      local editor = UI_TEST.frames.WispAIErrorQuestion
      assert(editor:GetText():find('Synthetic: missing reagent', 1, true))
      editor:SetText(editor:GetText() .. ' What can I check?')
      editor.scripts.OnTextChanged(editor)
      editor.scripts.OnEnterPressed({Insert=function() end})
      assert(#sends == 0, 'capture / selection / Explain / editing / Enter must not send')
      ns.Chat.Select('ordinary')
      assert(ns.db.drafts.ordinary == 'Keep my normal draft')
      assert(ns.draft:GetText() == 'Keep my normal draft')
      assert(#sends == 1 and sends[1].type == 'select')
      click('Send to Wisp')
      assert(sends[2].type == 'say' and sends[2].text:find('What can I check?', 1, true))
      assert(ns.db.drafts.ordinary == 'Keep my normal draft')
      assert(ns.draft:GetText() == 'Keep my normal draft')
      assert(editor:GetText() == '')
      click('Disable & clear')
      assert(#ns.RecentErrors.Read().records == 0)
    `);
  } finally {
    f.close();
  }
});

test('strict request schema bounds declared intent; requested=true is not authentication or consent proof', async () => {
  const { inspectionSchema } = await import('@wisp/protocol/game-inspection');
  expect(
    inspectionSchema.safeParse({ kind: 'game_errors', args: { requested: true } }).success,
  ).toBe(true);
  expect(inspectionSchema.safeParse({ kind: 'game_errors', args: {} }).success).toBe(false);
  expect(
    inspectionSchema.safeParse({ kind: 'game_errors', args: { requested: true, limit: 31 } })
      .success,
  ).toBe(false);
});
