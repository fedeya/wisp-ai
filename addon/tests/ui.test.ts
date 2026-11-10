import { addonSource } from './addon-source.ts';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
test('chat placeholder distinguishes connecting, fetching history and an empty conversation', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(`C={db={sidebar=true,showTools=true,drafts={}},active='chat',connected=false}
    C.chats={{id='chat',title='Test',status='idle',activity={}}}
    function C.Current() return C.chats[1] end
    assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C)
    C.BuildUI()
    local header=UI_TEST.frames.WispAISettingsButton.parent
    local setPoint=header.title.SetPoint
    local titleLeft
    header.title.SetPoint=function(self,point,relative,relativePoint,x,y)
      if point=='LEFT' then titleLeft={relative,relativePoint,x,y} end
      setPoint(self,point,relative,relativePoint,x,y)
    end
    header.titleAnchor=nil
    C.Refresh()
    assert(titleLeft and titleLeft[1]==header.logo and titleLeft[2]=='RIGHT' and titleLeft[3]>0,
      'refresh must keep the title to the right of the logo')
    local state=UI_TEST.frames.WispAIChatPlaceholder
    assert(state:IsShown() and state.loading and state.title:GetText()=='Waiting for bridge')
    assert(state.mouseEnabled==false)
    local alpha
    state.dots[1].SetAlpha=function(_,value)alpha=value end
    UI_TEST.frames.WispAIWindow.scripts.OnUpdate(nil,0.3)
    local before=alpha
    UI_TEST.now=0.5
    UI_TEST.frames.WispAIWindow.scripts.OnUpdate(nil,0.3)
    assert(alpha~=before,'the loading indicator must animate')
    C.connected=true
    C.Refresh()
    assert(state:IsShown() and state.loading and state.title:GetText()=='Loading conversation')
    C.chats[1].messages={}
    C.Refresh()
    assert(state:IsShown() and not state.loading and state.title:GetText()=='Ask Wisp')
    assert(not state.dots[1]:IsShown())
    C.chats[1].status='working'
    C.Refresh()
    assert(not state:IsShown(),'thinking has its own transcript row')
    C.chats[1]={id='cached',title='Cached',status='done',messages={{id='a',role='assistant',text='Hello'}}}
    C.connected=false
    C.Refresh()
    assert(not state:IsShown(),'disconnection must not obscure cached history')
    C.chats[1]={id='other',title='Other',status='done'}
    C.connected=true
    C.Refresh()
    assert(state:IsShown() and state.title:GetText()=='Loading conversation')
    C.chats[1].messages={{id='b',role='assistant',text='Loaded'}}
    C.Refresh()
    assert(not state:IsShown(),'the placeholder disappears when history arrives')
    C_Item={GetItemIconByID=function(id)assert(id==100)return 12345 end}
    GetItemInfo=function()return 'Robe',nil,2 end
    GetItemQualityColor=function()return 0,1,0,'ff1eff00' end
    local item=C.FormatText('[[ref:item]]',{item={kind='item',id=100,label='Robe'}},false)
    assert(item:find('|T12345:12:12:0:-2|t',1,true) and item:find('|cff1eff00|Hitem:100',1,true),'item references use aligned native icons and known quality')
    local map=C.FormatText('[[ref:map]]',{map={kind='map',mapId=1454,label='Orgrimmar'}},false)
    assert(map:find('INV_Misc_Map_01',1,true) and map:find('|cff80cf91|Hwispzone:1454',1,true),'map references have a distinct icon and color')
  `);
});
test('context meter distinguishes unknown usage, measured context and compaction without adding a transcript row', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(`C={db={sidebar=true,showTools=true,drafts={}},active='chat',connected=true}
    C.chats={{id='chat',title='Test',status='idle',messages={},activity={}}}
    function C.Current() return C.chats[1] end
    assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C)
    C.BuildUI()
    local meter=UI_TEST.frames.WispAIContextUsage
    assert(meter.text:GetText()=='Context --')
    C.contextPolicy={windowTokens=100000,compactAt=0.75}
    C.chats[1].usage={contextTokens=24000,inputTokens=50000,outputTokens=1000,cacheReadTokens=10000,compactions=1}
    C.Refresh()
    assert(meter.text:GetText()=='Context ~24%')
    local lines={}
    GameTooltip={SetOwner=function()end,Show=function()end,Hide=function()end,AddLine=function(_,text)table.insert(lines,text)end}
    meter.scripts.OnEnter(meter)
    assert(table.concat(lines,'|'):find('not your subscription allowance',1,true))
    assert(table.concat(lines,'|'):find('Auto compact: 75%',1,true))
    C.chats[1].usage.compacting=true
    C.chats[1].status='working'
    C.Refresh()
    assert(meter.text:GetText()=='Compacting...')
    assert(#C.chats[1].messages==0)
    C.chats[1].usage.compacting=false
    C.chats[1].usage.contextTokens=nil
    C.Refresh()
    assert(meter.text:GetText()=='Context --')
  `);
});
test('native renderer reuses rows, has a visible scrollbar, and preserves a reader position', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(
    `
C = { db = { sidebar = true, showTools = true, drafts = {} }, active = "chat", connected = true }
C.chats = {
    {
        id = "chat",
        title = "Test",
        status = "done",
        messages = {
            { id = "user-1", role = "user", text = string.rep("Long message ", 200) },
            {
                id = "tool-1",
                role = "tool",
                text = "Reading spells",
                tool = { label = "Reading spells", status = "completed" },
            },
        },
    },
}
function C.Current()
    return C.chats[1]
end
`,
  );
  run(`assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C); C.BuildUI()`);
  run(
    `
C.capabilities = {
    {
        id = "tool:query_character",
        name = "Character readings",
        description = "On-demand readings",
        group = "integrations",
        enabled = true,
    },
    { id = "mcp:everloot", name = "Everloot", description = "Database", group = "integrations", enabled = true },
    {
        id = "mcp_tool:everloot:market_value",
        name = "market value",
        description = "Prices",
        group = "integrations",
        parent = "mcp:everloot",
        enabled = true,
    },
}
C.capabilityPending = {}
C.SetCapability = function(id, enabled)
    UI_TEST.capabilityAction = { id = id, enabled = enabled }
end
C.RefreshCapabilities()
local toolRow
for _, w in ipairs(UI_TEST.widgets) do
    if w.entry and w.entry.id == "tool:query_character" then
        toolRow = w
    end
end
assert(toolRow and toolRow.check:GetChecked())
toolRow.check:SetChecked(false)
toolRow.check.scripts.OnClick(toolRow.check)
assert(
    UI_TEST.capabilityAction.id == "tool:query_character"
        and UI_TEST.capabilityAction.enabled == false
)
for _, w in ipairs(UI_TEST.widgets) do
    if w:GetText() == "MCPs" and w.scripts.OnClick then
        w.scripts.OnClick()
    end
end
C.capabilityPending["mcp:everloot"] = { enabled = false }
C.RefreshCapabilities()
local child
for _, w in ipairs(UI_TEST.widgets) do
    if w.entry and w.entry.id == "mcp_tool:everloot:market_value" then
        child = w
    end
end
assert(
    child
        and child.check:GetChecked()
        and not child.check.enabled
        and child.state:GetText() == "Off",
    "turning off an MCP must disable its children without erasing their preferences"
)
C.capabilityPending = {}
C.RefreshCapabilities()
assert(child.check.enabled)
C.capabilities = {}
C.RefreshCapabilities()
assert(not child:IsShown())
`,
  );
  run(
    `
C.MemoryAction = function(action, slot, key, text)
    UI_TEST.memoryAction = { action = action, slot = slot, key = key, text = text }
end
C.memory = { status = "available", entries = {
    { slot = "character", key = "guide", text = "Following Guide A" },
} }
C.RefreshMemory()
local row
for _, w in ipairs(UI_TEST.widgets) do
    if w.entry and w.entry.key == "guide" then
        row = w
    end
end
assert(row and row.text:GetText() == "Following Guide A", "saved plans must be visible in Settings")
row.edit.scripts.OnClick()
assert(UI_TEST.popup.id == "WISPAI_EDIT_MEMORY")
StaticPopupDialogs.WISPAI_EDIT_MEMORY.OnAccept(
    { editBox = {
        GetText = function()
            return "Following Guide B"
        end,
    } },
    row.entry
)
assert(UI_TEST.memoryAction.action == "save" and UI_TEST.memoryAction.text == "Following Guide B")
row.remove.scripts.OnClick()
assert(
    UI_TEST.memoryAction.action == "remove"
        and UI_TEST.memoryAction.key == "guide"
        and UI_TEST.memoryAction.slot == "character"
)
C.memory = { status = "available", entries = {} }
C.RefreshMemory()
assert(not row:IsShown(), "forgotten entries must disappear")
`,
  );
  run(
    `
local fold = UI_TEST.frames.WispAISidebarToggle
local gear = UI_TEST.frames.WispAISettingsButton
local tabs = {}
for _, widget in ipairs(UI_TEST.widgets) do
    if widget.parent == fold.parent and (widget:GetText() == "Chats" or widget:GetText() == "Routines") then
        tabs[#tabs + 1] = widget
    end
end
assert(#tabs == 2 and tabs[1]:IsShown() and tabs[2]:IsShown())
assert(fold.parent ~= gear.parent, "sidebar toggle must live in the sidebar")
assert(gear:GetText() == "", "settings uses an icon instead of a text label")
fold.scripts.OnClick()
assert(
    not C.db.sidebar and fold:GetText() == ">" and fold.parent:GetWidth() == 30,
    "collapsed sidebar must retain its own expand control"
)
assert(not tabs[1]:IsShown() and not tabs[2]:IsShown(), "collapsed sidebar must hide both tabs so they cannot overlap the conversation")
fold.scripts.OnClick()
assert(C.db.sidebar and fold:GetText() == "<")
assert(tabs[1]:IsShown() and tabs[2]:IsShown(), "expanding the sidebar must restore both tabs")
C.SetMinimized(true)
assert(
    UI_TEST.frames.WispAIWindow:GetWidth() == 220 and not fold:IsShown() and not gear:IsShown(),
    "minimized bar must be compact and hide secondary controls"
)
C.SetMinimized(false)
assert(fold:IsShown() and gear:IsShown(), "expanding must restore controls")
`,
  );
  run(
    `
local bar = UI_TEST.frames.WispAITranscriptScrollBar
assert(bar and bar:IsShown())
assert(bar.max > 100)
local writes = UI_TEST.textWrites
local hides = UI_TEST.hides
C.Refresh()
assert(UI_TEST.textWrites == writes, "unchanged snapshots must not replace text")
assert(UI_TEST.hides == hides, "unchanged snapshots must not hide message rows")
bar:SetValue(30)
table.insert(
    C.chats[1].messages,
    { id = "answer-1", role = "assistant", text = string.rep("New answer ", 100) }
)
C.Refresh()
assert(bar:GetValue() == 30, "incoming content must not pull the reader to the bottom")
`,
  );
  run(
    `
local window = UI_TEST.frames.WispAIWindow
window:ClearAllPoints()
window:SetPoint("CENTER", UIParent, "CENTER", 100, 200)
C.SetMinimized(true)
window:ClearAllPoints()
window:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 800, -600)
C.SaveWindowPosition(true)
C.SetMinimized(false)
local p, _, _, x, y = window:GetPoint()
assert(
    p == "CENTER" and x == 100 and y == 200,
    "expanded position must survive moving the minimized bar"
)
C.SetMinimized(true)
p, _, _, x, y = window:GetPoint()
assert(p == "TOPLEFT" and x == 800 and y == -600, "minimized position must also be remembered")
C.SetMinimized(false)
C.RequestDeleteChat("chat")
assert(UI_TEST.popup and UI_TEST.popup.data == "chat", "deletion requires explicit confirmation")
`,
  );
  run(
    `
local progress = UI_TEST.frames.WispAIProgress
assert(not progress:IsShown())
C.chats[1].status = "working"
C.pendingMessages = { m = { chat = "chat" } }
C.Refresh()
assert(
    progress:IsShown() and progress.title:GetText() == "Sending.",
    "sending must be visible before bridge confirmation"
)
C.pendingMessages = {}
C.Refresh()
assert(
    progress.title:GetText():match("^Thinking"),
    "an acknowledged message should show an assistant thinking row"
)
C.chats[1].activity = { { label = "Searching the web", status = "running" } }
UI_TEST.now = 7
local offset = UI_TEST.frames.WispAITranscriptScrollBar:GetValue()
local hides = UI_TEST.hides
UI_TEST.frames.WispAIWindow.scripts.OnUpdate(nil, 0.25)
assert(progress.title:GetText():find("Searching the web", 1, true))
assert(progress.elapsed:GetText() == "7s")
assert(progress.detail:GetText() == "Searching the web")
assert(
    UI_TEST.hides == hides and UI_TEST.frames.WispAITranscriptScrollBar:GetValue() == offset,
    "progress ticks must not redraw or scroll messages"
)
C.chats[1].status = "done"
C.Refresh()
assert(not progress:IsShown(), "completion must clear the busy indicator")
C.chats[1].status = "working"
UI_TEST.now = 80
C.Refresh()
assert(progress.elapsed:GetText() == "0s", "a new turn must restart the timer")
`,
  );
});

test('macro references show the actual code and pick up by current name without executing', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(
    `
C = { db = { sidebar = true, showTools = true, drafts = {} }, active = "chat", connected = true }
C.chats = {
    {
        id = "chat",
        title = "Macros",
        status = "done",
        messages = {
            {
                id = "reply",
                role = "assistant",
                text = "[[ref:nova]]",
                references = { nova = { kind = "macro", name = "Nova", label = "Nova" } },
            },
        },
    },
}
function C.Current()
    return C.chats[1]
end
function C.Log(text)
    UI_TEST.notice = text
end
function GetMacroIndexByName(name)
    assert(name == "Nova")
    return 121
end
function GetMacroInfo(index)
    return "Nova", 134400, "/cast Frost Nova"
end
function PickupMacro(index)
    UI_TEST.pickedMacro = index
end
function RunMacroText()
    error("must not execute")
end
function InCombatLockdown()
    return combat or false
end
`,
  );
  run(
    `assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C); C.BuildUI(); local row; for _,w in ipairs(UI_TEST.widgets) do if w.scripts.OnHyperlinkEnter and type(w.text)=='table' then row=w end end; assert(row.text:GetText():find('|Hwispmacro:4e6f7661|h[Nova]|h',1,true)); row.scripts.OnHyperlinkEnter(row,'wispmacro:4e6f7661','[Nova]'); assert(GameTooltip:GetText()=='Nova'); row.scripts.OnHyperlinkClick(row,'wispmacro:4e6f7661','[Nova]','LeftButton'); assert(UI_TEST.pickedMacro==121); combat=true; UI_TEST.pickedMacro=nil; row.scripts.OnHyperlinkClick(row,'wispmacro:4e6f7661','[Nova]','LeftButton'); assert(UI_TEST.pickedMacro==nil and UI_TEST.notice:find('combat'))`,
  );
});

test('structured skill replies use the declared skill and map references support hover and native clicks', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(
    `C={db={sidebar=true,showTools=true,drafts={}},active='chat',connected=true}; C.chats={{id='chat',title='References',status='done',messages={{id='question',role='user',text='|cff71d5ff|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h|r?'},{id='reply',role='assistant',references={skill={kind='spell',id=11070,payload='spell:11070:0',label='Descarga de Escarcha mejorada'},zone={kind='map',mapId=1411,label='Durotar'},ramp={kind='map',mapId=1411,x=45,y=62.5,label='Rampa'}},text='Sí, [[ref:skill]]. Descarga de Escarcha mejoradaExtra. ` +
      '`Descarga de Escarcha mejorada`' +
      ` [[ref:zone]] [[ref:ramp]]'}}}}; function C.Current() return C.chats[1] end; C_Map={GetMapInfo=function() return {name='Durotar'} end,OpenWorldMap=function(id) UI_TEST.openedMap=id end}`,
  );
  run(
    `assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C); C.BuildUI(); local row; for _,w in ipairs(UI_TEST.widgets) do if w.scripts.OnHyperlinkEnter and type(w.text)=='table' and w.text:GetText():find('Rampa',1,true) then row=w end end; assert(row); local text=row.text:GetText(); assert(text:find('|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h',1,true),'plain text must reuse the exact skill link supplied by the user'); local _,count=text:gsub('|Hspell:', ''); assert(count==1,'code spans and larger words must not be auto-linked'); assert(text:find('|Hwispzone:1411|h[Durotar]|h',1,true)); assert(text:find('|Hworldmap:1411:4500:6250|h[Rampa (45.0, 62.5)]|h',1,true),'map percentages must become native 0–10000 coordinates'); row.scripts.OnHyperlinkEnter(row,'worldmap:1411:4500:6250','[Rampa]'); assert(GameTooltip:GetText()=='Durotar'); row.scripts.OnHyperlinkClick(row,'worldmap:1411:4500:6250','[Rampa]','LeftButton'); assert(UI_TEST.clickedLink=='worldmap:1411:4500:6250'); row.scripts.OnHyperlinkClick(row,'wispzone:1411','[Durotar]','LeftButton'); assert(UI_TEST.openedMap==1411); C.chats[1].messages[2].references.ramp.x=46; C.Refresh(); assert(row.text:GetText():find('worldmap:1411:4600:6250',1,true),'late reference changes must update the existing row even when the text is unchanged')`,
  );
});

test('prose around generated cards keeps spell and item hover, clicks and scrolling on its own frame', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run('C = {}');
  run(`assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI', C)`);
  run(`assert(load(${JSON.stringify(addonSource('RichUI.lua'))}))('WispAI', C)`);
  run(`
local spell = 'Use [[ref:spell]] first.'
local item = 'Keep [[ref:item]] equipped.'
local message = {
    id = 'reply', role = 'assistant', text = spell .. '\\n' .. item,
    references = {
        spell = { kind = 'spell', id = 2137, label = 'Explosión de Fuego' },
        item = { kind = 'item', id = 1733, payload = 'item:1733:0', label = 'Capa desgastada' },
    },
    ui = {{ id = 'result', kind = 'stat', label = 'DPS', value = '31.2' }},
    parts = {{ type = 'text', text = spell }, { type = 'ui', id = 'result' }, { type = 'text', text = item }},
}
local chat = { id = 'chat', status = 'done', messages = { message } }
local row = C.MakeMessageRow(CreateFrame('Frame'))
C.RenderMessageRow(row, chat, message, 500, true)
assert(not row.text:IsShown(), 'interleaved replies use the rich prose, not the ordinary row text')
local first, second = row.rich.prose[1], row.rich.prose[2]
assert(first:GetText():find('|Hspell:2137|h[Explosión de Fuego]|h', 1, true))
assert(second:GetText():find('|Hitem:1733:0|h[Capa desgastada]|h', 1, true))
for _, entry in ipairs({{first, 'spell:2137'}, {second, 'item:1733:0'}}) do
    local owner, link = entry[1]:GetParent(), entry[2]
    assert(owner.mouseEnabled and owner.hyperlinksEnabled and owner.scripts.OnHyperlinkEnter,
        'the frame owning visible prose must receive hyperlink events')
    owner.scripts.OnHyperlinkEnter(owner, link, '[Reference]')
    assert(GameTooltip:IsShown() and UI_TEST.tooltipLink == link and C.hoverLink == '[Reference]')
    owner.scripts.OnHyperlinkLeave(owner)
    assert(not GameTooltip:IsShown() and C.hoverLink == nil)
    owner.scripts.OnHyperlinkClick(owner, link, '[Reference]', 'LeftButton')
    assert(UI_TEST.clickedLink == link)
end
local scrolled
C.ScrollTranscript = function(delta) scrolled = delta end
first:GetParent().scripts.OnMouseWheel(first:GetParent(), -1)
assert(scrolled == -1, 'interactive prose must preserve transcript scrolling')
local owner = first:GetParent()
C.RenderMessageRow(row, chat, message, 230, true)
assert(row.rich.prose[1] == first and first:GetParent() == owner)
assert(owner.scripts.OnHyperlinkEnter, 'resize must keep the interactive owner')
`);
});

test('verified references support hover and quest clicks without reserving transcript space for progress', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
  run(`
C = { db = { sidebar = true, showTools = true, drafts = {} }, active = "chat", connected = true }
C.chats = {
    {
        id = "chat",
        title = "Links",
        status = "idle",
        messages = {
            {
                id = "reply",
                role = "assistant",
                references = {
                    quest = { kind = "quest", id = 12, payload = "quest:12:10", label = "Las arpías" },
                    nova = { kind = "spell", id = 122, label = "Nova" },
                    robe = { kind = "item", id = 100, label = "Robe" },
                    other = { kind = "quest", id = 99, label = "Other quest" },
                    native = { kind = "item", id = 200, payload = "item:200:0", label = "Native robe" },
                },
                text = "Finish [[ref:quest]]. [[ref:nova]], [[ref:robe]], [[ref:other]]. Unknown Quest. [[ref:native]]",
            },
        },
    },
}
function C.Current()
    return C.chats[1]
end
C_QuestLog = {
    GetNumQuestLogEntries = function()
        return 1
    end,
    GetInfo = function()
        return { questID = 12, title = "Las arpías", level = 10 }
    end,
    GetQuestObjectives = function()
        return { { text = "Sacks: 5/5", finished = true } }
    end,
}
function QuestMapFrame_OpenToQuestDetails(id)
    UI_TEST.openedQuest = id
end
`);
  run(`assert(load(${JSON.stringify(addonSource('UI.lua'))}))('WispAI',C); C.BuildUI()`);
  run(
    `
local row
for _, w in ipairs(UI_TEST.widgets) do
    if w.scripts.OnHyperlinkEnter and w.text and type(w.text) == "table" then
        row = w
    end
end
assert(
    row and row.mouseEnabled and row.hyperlinksEnabled,
    "hyperlink rows must receive mouse input"
)
local text = row.text:GetText()
assert(
    text:find("|Hquest:12:10|h[Las arpías]|h", 1, true),
    "declared quest references should preserve their payload"
)
assert(text:find("|Hspell:122|h[Nova]|h", 1, true), "uncached spells must remain links")
assert(text:find("|Hitem:100|h[Robe]|h", 1, true), "uncached items must remain links")
assert(text:find("|Hquest:99|h[Other quest]|h", 1, true))
assert(
    text:find("|cffe3c77e|Hitem:200:0|h[Native robe]|h|r", 1, true),
    "native pasted links must survive formatting"
)
assert(not text:find("||H", 1, true))
assert(text:find("Unknown Quest.", 1, true), "unknown names must not acquire invented IDs")
row.scripts.OnHyperlinkEnter(row, "quest:12:10", "[Las arpías]")
assert(GameTooltip:GetText() == "Las arpías")
row.scripts.OnHyperlinkClick(row, "quest:12:10", "[Las arpías]", "LeftButton")
assert(UI_TEST.openedQuest == 12)
row.scripts.OnHyperlinkEnter(row, "item:100", "[Robe]")
assert(UI_TEST.tooltipLink == "item:100")
row.scripts.OnHyperlinkClick(row, "item:100", "[Robe]", "LeftButton")
assert(UI_TEST.clickedLink == "item:100")
function IsShiftKeyDown()
    return true
end
function C.draft:Insert(text)
    UI_TEST.insertedLink = text
end
row.scripts.OnHyperlinkClick(row, "quest:12:10", "|Hquest:12:10|h[Las arpías]|h", "LeftButton")
assert(UI_TEST.insertedLink:find("|Hquest:12:10", 1, true))
local progress = UI_TEST.frames.WispAIProgress
assert(
    progress.parent == row.parent
        and progress.parent ~= C.draft.parent
        and progress.author:GetText() == "Wisp AI",
    "progress belongs in the transcript as an assistant row"
)
local bar = UI_TEST.frames.WispAITranscriptScrollBar
local _, _, _, _, bottom = bar:GetPoint()
assert(bottom == 104, "there must be no additional reserved progress gap")
C.chats[1].status = "working"
C.Refresh()
assert(
    progress:IsShown()
        and progress.parent:GetHeight() == progress.y + progress:GetHeight()
        and #C.chats[1].messages == 1,
    "thinking occupies transcript space without becoming a saved message"
)
C.chats[1].status = "done"
C.Refresh()
assert(
    not progress:IsShown() and progress.parent:GetHeight() == progress.y,
    "completion removes the transient row and its space"
)
`,
  );
});
