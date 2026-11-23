local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
end

it("keeps multiline drafts clipped and follows the cursor across composer layouts", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    ns = helper.namespace({
        db = { sidebar = true, showTools = true, drafts = {} },
        active = "chat",
        connected = true,
    })
    ns.chats = { { id = "chat", title = "Draft", status = "idle", messages = {} } }
    function ns.Chat.Current()
        return ns.chats[1]
    end
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    local draft = ns.draft
    local viewport = UI_TEST.frames.WispAIInputScroll
    local bar = UI_TEST.frames.WispAIInputScrollBar
    assert(not bar:IsShown(), "the scrollbar must start hidden")
    assert(viewport and viewport.kind == "ScrollFrame" and viewport.clipsChildren)
    assert(viewport.child == draft and draft:GetParent() == viewport)
    viewport:SetSize(300, 43)
    viewport.scripts.OnSizeChanged(viewport, 300, 43)
    assert(draft:GetWidth() == 300, "wrapping must follow the viewport width")
    draft:SetHeight(43)
    viewport.scripts.OnScrollRangeChanged(viewport)
    assert(not bar:IsShown(), "text that exactly fits must not show a scrollbar")
    draft:SetHeight(44)
    viewport.scripts.OnScrollRangeChanged(viewport)
    assert(bar:IsShown(), "the scrollbar must appear as soon as text overflows")

    -- Emulate native multiline EditBox growth and cursor events.
    function draft:Insert(text)
        self:SetText(self:GetText() .. text)
        local _, breaks = self:GetText():gsub("\n", "")
        self:SetHeight((breaks + 1) * 16)
        self.scripts.OnTextChanged(self, true)
        self.scripts.OnCursorChanged(self, 0, -breaks * 16, 1, 16)
    end
    function IsShiftKeyDown()
        return true
    end
    for _ = 1, 40 do
        draft.scripts.OnEnterPressed(draft)
        assert(
            draft:GetHeight() <= viewport:GetVerticalScroll() + viewport:GetHeight(),
            "each Shift+Enter must keep the new line visible"
        )
    end
    assert(#draft:GetText() == 40 and viewport:GetVerticalScroll() > 0)
    local field = viewport:GetParent()
    assert(field:GetHeight() == 168, "the field grows with its text up to its maximum")
    assert(bar:IsShown() and bar:GetValue() == viewport:GetVerticalScroll())
    bar:SetValue(120)
    assert(viewport:GetVerticalScroll() == 120, "dragging the scrollbar must scroll the draft")
    viewport:SetVerticalScroll(80)
    viewport.scripts.OnVerticalScroll(viewport, 80)
    assert(bar:GetValue() == 80, "native scrolling must keep the thumb in sync")
    viewport:SetHeight(draft:GetHeight())
    viewport.scripts.OnSizeChanged(viewport, 300)
    assert(not bar:IsShown(), "enlarging the viewport to fit must hide the scrollbar")
    viewport:SetHeight(43)
    viewport.scripts.OnSizeChanged(viewport, 300)
    assert(bar:IsShown(), "shrinking the viewport must restore the scrollbar")
    draft.scripts.OnCursorChanged(draft, 0, 0, 1, 16)
    assert(viewport:GetVerticalScroll() == 0, "moving to the first line must scroll up")
    draft.scripts.OnCursorChanged(draft, 0, -320, 1, 16)
    assert(viewport:GetVerticalScroll() <= 320)
    assert(viewport:GetVerticalScroll() + viewport:GetHeight() >= 336)
    viewport.scripts.OnMouseWheel(viewport, 1000)
    assert(viewport:GetVerticalScroll() == 0)
    viewport.scripts.OnMouseWheel(viewport, -1000)
    assert(viewport:GetVerticalScroll() == viewport:GetVerticalScrollRange())
    draft:SetText("short")
    draft:SetHeight(16)
    draft.scripts.OnTextChanged(draft, false)
    assert(viewport:GetVerticalScroll() == 0, "shorter restored drafts must clamp the scroll")
    -- One 16-unit test line plus the padding that centers a 12-unit font in 40.
    assert(field:GetHeight() == 44, "a one-line draft shrinks the field back to one line")
    assert(not bar:IsShown() and bar:GetValue() == 0)
    viewport:SetVerticalScroll(100)
    draft:SetText("")
    draft:SetHeight(12) -- a native empty EditBox is one font line tall
    draft.scripts.OnTextChanged(draft, false)
    assert(viewport:GetVerticalScroll() == 0, "clearing the draft must reset the scroll")
    assert(field:GetHeight() == 40, "an empty draft is exactly the one-line field")

    local controls = UI_TEST.frames.WispAIChatModelControls
    local meter = UI_TEST.frames.WispAIContextUsage
    assert(controls:GetParent() ~= field, "model choices sit below the field, not inside it")
    for _, width in ipairs({ 350, 500, 350 }) do
        field:SetWidth(width)
        field.scripts.OnSizeChanged(field, width)
        ns.UI.Refresh()
        local point, _, _, _, bottom = viewport:GetPoint()
        assert(point == "BOTTOMRIGHT" and bottom == 14, "text is centered on the font size")
        local transcriptBar = UI_TEST.frames.WispAITranscriptScrollBar
        local _, _, _, _, transcriptBottom = transcriptBar:GetPoint()
        assert(transcriptBottom == 90, "a one-line field keeps the transcript just above it")
        assert(meter:IsShown() == (width >= 400), "narrow fields leave the row to the model")
        local _, parent = draft:GetPoint()
        assert(parent == viewport, "layout changes must keep the editor inside its scroll area")
    end
    local submitted = 0
    function IsShiftKeyDown()
        return false
    end
    function ns.Chat.Submit()
        submitted = submitted + 1
    end
    draft.scripts.OnEnterPressed(draft)
    assert(submitted == 1, "Enter must still submit")
end)

it("sends the starter prompt from the empty chat while preserving the draft", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = {} },
        connected = true,
        session = "test",
        chats = {},
        pendingChats = {},
        pendingMessages = {},
        workStarted = {},
    })
    local sent = {}
    function ns.Transport.Send(packet)
        sent[#sent + 1] = packet
    end
    helper.addon("Chat/State.lua", env)
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()

    local starter = UI_TEST.frames.WispAIChatPlaceholder.starter
    assert(starter:IsShown() and starter:GetText() == "What can you do?")
    ns.draft:SetText("My next question")
    starter.scripts.OnClick()

    assert(#sent == 2 and sent[1].type == "new" and sent[2].type == "say")
    assert(sent[2].chat == ns.active and sent[2].text == "What can you do?")
    local chat = ns.Chat.Current()
    assert(chat.status == "working" and chat.messages[1].text == sent[2].text)
    assert(ns.draft:GetText() == "My next question")
    assert(not starter:IsShown())
end)

it("New chat creates its conversation with the first message and keeps its draft", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = {} },
        connected = true,
        session = "test",
        active = "old",
        chats = {
            {
                id = "old",
                title = "Old",
                status = "done",
                messages = { { id = "m", role = "user", text = "Hi" } },
                activity = {},
            },
        },
        pendingChats = {},
        pendingMessages = {},
        workStarted = {},
    })
    local sent = {}
    function ns.Transport.Send(packet)
        sent[#sent + 1] = packet
    end
    helper.addon("Chat/State.lua", env)
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    for index = #sent, 1, -1 do
        sent[index] = nil
    end

    ns.Chat.StartNew()
    assert(#sent == 0 and ns.active == nil and #ns.chats == 1, "New chat creates nothing yet")
    ns.draft:SetText("Plan my route")
    ns.Chat.Select("old")
    assert(ns.draft:GetText() == "")
    ns.Chat.StartNew()
    assert(ns.draft:GetText() == "Plan my route", "returning to New chat restores its draft")
    for index = #sent, 1, -1 do
        sent[index] = nil
    end
    ns.Chat.Submit()
    assert(#sent == 2 and sent[1].type == "new" and sent[2].type == "say")
    assert(sent[2].text == "Plan my route" and sent[2].chat == ns.active)
    assert(#ns.chats == 2 and ns.draft:GetText() == "")
    ns.Chat.StartNew()
    assert(ns.draft:GetText() == "", "a sent draft does not come back")
end)

it("AskNew asks in a new conversation and leaves every draft where it was", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = { __new = "Plan my route" } },
        connected = true,
        session = "test",
        active = "old",
        chats = {
            {
                id = "old",
                title = "Old",
                status = "done",
                messages = { { id = "m", role = "user", text = "Hi" } },
                activity = {},
            },
        },
        pendingChats = {},
        pendingMessages = {},
        workStarted = {},
    })
    local sent = {}
    function ns.Transport.Send(packet)
        sent[#sent + 1] = packet
    end
    helper.addon("Chat/State.lua", env)
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    ns.draft:SetText("Half-typed reply")

    ns.Chat.AskNew("Why did I just die?")
    assert(ns.active ~= "old" and sent[#sent].type == "say")
    assert(sent[#sent].chat == ns.active and sent[#sent].text == "Why did I just die?")
    assert(ns.draft:GetText() == "", "the new conversation starts with an empty composer")
    ns.Chat.Select("old")
    assert(ns.draft:GetText() == "Half-typed reply", "the open conversation keeps its draft")
    ns.Chat.StartNew()
    assert(ns.draft:GetText() == "Plan my route", "the New chat draft is untouched")
end)

it("Recents are grouped under day headings that keep rows pooled and in order", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    date, time = os.date, os.time
    local day = 86400 * 1000
    local now = os.time() * 1000
    local function chat(id, at)
        return {
            id = id,
            title = id,
            status = "done",
            messages = {},
            activity = {},
            lastActivityAt = at,
        }
    end
    ns = helper.namespace({
        db = { sidebar = true, drafts = {} },
        connected = true,
        active = "today",
        chats = {
            chat("older", now - 90 * day),
            chat("today", now),
            chat("yesterday", now - day),
            chat("week", now - 3 * day),
            chat("month", now - 12 * day),
            chat("week-later", now - 4 * day),
        },
        pendingChats = {},
        pendingMessages = {},
        workStarted = {},
    })
    helper.addon("Chat/State.lua", env)
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    local function row(id)
        for _, w in ipairs(UI_TEST.widgets) do
            if w.chatId == id and w.label then
                return w
            end
        end
    end
    local list = row("today").parent
    local function headings()
        local shown = {}
        for _, w in ipairs(UI_TEST.widgets) do
            if w.parent == list and not w.chatId and w:IsShown() and w:GetText() ~= "" then
                shown[#shown + 1] = { text = w:GetText(), y = w.y }
            end
        end
        table.sort(shown, function(a, b)
            return a.y < b.y
        end)
        local texts = {}
        for index, heading in ipairs(shown) do
            texts[index] = heading.text
        end
        return table.concat(texts, ","), shown
    end
    local text, shown = headings()
    assert(text == "Today,Yesterday,Previous 7 days,Previous 30 days,Older", text)
    local order = { "today", "yesterday", "week", "week-later", "month", "older" }
    for index = 2, #order do
        assert(row(order[index - 1]).y < row(order[index]).y, "rows keep newest-first order")
    end
    assert(shown[1].y < row("today").y and row("today").y < shown[2].y)
    assert(shown[3].y < row("week").y and row("week-later").y < shown[4].y)
    assert(row("today").selected, "the selected row stays selected under its heading")
    local today = row("today")

    ns.chats = { chat("today", now), chat("week", now - 3 * day) }
    ns.UI.Sidebar.Refresh()
    text = headings()
    assert(text == "Today,Previous 7 days", text)
    assert(row("today") == today, "headings do not disturb row reuse")
    assert(not row("older"):IsShown(), "rows of removed chats are hidden")
end)

it(
    "chat placeholder distinguishes connecting, fetching history and an empty conversation",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        ns = helper.namespace({
            db = { sidebar = true, showTools = true, drafts = {} },
            active = "chat",
            connected = false,
        })
        ns.chats = { { id = "chat", title = "Test", status = "idle", activity = {} } }
        function ns.Chat.Current()
            return ns.chats[1]
        end
        helper.addon("UI/Window.lua", env)
        ns.UI.BuildUI()
        local header = UI_TEST.frames.WispAIHeader
        ns.UI.Refresh()
        local point, relative, relativePoint, x = header.title:GetPoint()
        assert(
            point == "LEFT" and relative == header.logo and relativePoint == "RIGHT" and x > 0,
            "refresh must keep the title to the right of the logo"
        )
        local state = UI_TEST.frames.WispAIChatPlaceholder
        assert(state:IsShown() and state.loading)
        assert(state.title:GetText() == "Open Wisp Desktop to connect")
        assert(state.detail:GetText() == "")
        assert(state.mouseEnabled == false)
        assert(not state.setup:IsShown(), "a disconnected bridge should not prompt a download")
        assert(not state.starter:IsShown())
        ns.Transport.needsDesktopSetup = true
        ns.UI.Refresh()
        assert(state.setup:IsShown() and state.title:GetText() == "Finish Wisp setup")
        assert(not state.starter:IsShown())
        assert(state.setup:GetText() == "Setup help")
        assert(not state.loading and not state.dots[1]:IsShown())
        state.setup.scripts.OnClick()
        assert(UI_TEST.popup.id == "WISPAI_COPY_URL")
        assert(UI_TEST.popup.data == "https://wisp.fedeya.sh/setup?utm_source=wow_addon")
        ns.Transport.needsDesktopSetup = false
        ns.UI.Refresh()
        local alpha
        state.dots[1].SetAlpha = function(_, value)
            alpha = value
        end
        UI_TEST.frames.WispAIWindow.scripts.OnUpdate(nil, 0.3)
        local before = alpha
        UI_TEST.now = 0.5
        UI_TEST.frames.WispAIWindow.scripts.OnUpdate(nil, 0.3)
        assert(alpha ~= before, "the loading indicator must animate")
        ns.connected = true
        ns.UI.Refresh()
        assert(
            state:IsShown() and state.loading and state.title:GetText() == "Loading conversation"
        )
        assert(not state.starter:IsShown())
        ns.chats[1].messages = {}
        ns.UI.Refresh()
        assert(state:IsShown() and not state.loading and state.title:GetText() == "Ask Wisp")
        assert(state.starter:IsShown())
        assert(not state.dots[1]:IsShown())
        ns.chats[1].status = "working"
        ns.UI.Refresh()
        assert(not state:IsShown() and not state.starter:IsShown(), "thinking has its own row")
        ns.chats[1] = {
            id = "cached",
            title = "Cached",
            status = "done",
            messages = { { id = "a", role = "assistant", text = "Hello" } },
        }
        ns.connected = false
        ns.UI.Refresh()
        assert(not state:IsShown(), "disconnection must not obscure cached history")
        ns.chats[1] = { id = "other", title = "Other", status = "done" }
        ns.connected = true
        ns.UI.Refresh()
        assert(state:IsShown() and state.title:GetText() == "Loading conversation")
        ns.chats[1].messages = { { id = "b", role = "assistant", text = "Loaded" } }
        ns.UI.Refresh()
        assert(not state:IsShown(), "the placeholder disappears when history arrives")
        C_Item = {
            GetItemIconByID = function(id)
                assert(id == 100)
                return 12345
            end,
        }
        GetItemInfo = function()
            return "Robe", nil, 2
        end
        GetItemQualityColor = function()
            return 0, 1, 0, "ff1eff00"
        end
        local item = ns.UI.FormatText(
            "[[ref:item]]",
            { item = { kind = "item", id = 100, label = "Robe" } },
            false
        )
        assert(
            item:find("|T12345:12:12:0:-2|t", 1, true)
                and item:find("|cff1eff00|Hitem:100", 1, true),
            "item references use aligned native icons and known quality"
        )
        local map = ns.UI.FormatText(
            "[[ref:map]]",
            { map = { kind = "map", mapId = 1454, label = "Orgrimmar" } },
            false
        )
        assert(
            map:find("INV_Misc_Map_01", 1, true) and map:find("|cff80cf91|Hwispzone:1454", 1, true),
            "map references have a distinct icon and color"
        )
    end
)

it(
    "context meter distinguishes unknown usage, measured context and compaction without adding a transcript row",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        ns = helper.namespace({
            db = { sidebar = true, showTools = true, drafts = {} },
            active = "chat",
            connected = true,
        })
        ns.chats =
            { { id = "chat", title = "Test", status = "idle", messages = {}, activity = {} } }
        function ns.Chat.Current()
            return ns.chats[1]
        end
        helper.addon("UI/Window.lua", env)
        ns.UI.BuildUI()
        local meter = UI_TEST.frames.WispAIContextUsage
        assert(meter.text:GetText() == "Context --")
        ns.contextPolicy = { windowTokens = 100000, compactAt = 0.75 }
        ns.chats[1].usage = {
            contextTokens = 24000,
            inputTokens = 50000,
            outputTokens = 1000,
            cacheReadTokens = 10000,
            compactions = 1,
        }
        ns.UI.Refresh()
        assert(meter.text:GetText() == "Context ~24%")
        local lines = {}
        GameTooltip = {
            SetOwner = function() end,
            Show = function() end,
            Hide = function() end,
            AddLine = function(_, text)
                table.insert(lines, text)
            end,
        }
        meter.scripts.OnEnter(meter)
        assert(table.concat(lines, "|"):find("24k of 100k tokens", 1, true))
        assert(table.concat(lines, "|"):find("summarized at 75%", 1, true))
        ns.chats[1].usage.compacting = true
        ns.chats[1].status = "working"
        ns.UI.Refresh()
        assert(meter.text:GetText() == "Compacting...")
        assert(#ns.chats[1].messages == 0)
        ns.chats[1].usage.compacting = false
        ns.chats[1].usage.contextTokens = nil
        ns.UI.Refresh()
        assert(meter.text:GetText() == "Context --")
    end
)

it(
    "native renderer reuses rows, has a visible scrollbar, and preserves a reader position",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace({
                db = { sidebar = true, showTools = true, drafts = {} },
                active = "chat",
                connected = true,
            })
            ns.chats = {
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
            function ns.Chat.Current()
                return ns.chats[1]
            end
        end
        helper.addon("UI/Window.lua", env)
        ns.UI.BuildUI()
        do
            ns.capabilities = {
                {
                    id = "tool:query_character",
                    name = "Character readings",
                    description = "On-demand readings",
                    group = "integrations",
                    enabled = true,
                },
                {
                    id = "mcp:everloot",
                    name = "Everloot",
                    description = "Database",
                    group = "integrations",
                    enabled = true,
                },
                {
                    id = "mcp_tool:everloot:market_value",
                    name = "market value",
                    description = "Prices",
                    group = "integrations",
                    parent = "mcp:everloot",
                    enabled = true,
                },
            }
            ns.capabilityPending = {}
            ns.Chat.SetCapability = function(id, enabled)
                UI_TEST.capabilityAction = { id = id, enabled = enabled }
            end
            ns.UI.Capabilities.Refresh()
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
            ns.capabilityPending["mcp:everloot"] = { enabled = false }
            ns.UI.Capabilities.Refresh()
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
            ns.capabilityPending = {}
            ns.UI.Capabilities.Refresh()
            assert(child.check.enabled)
            ns.capabilities = {}
            ns.UI.Capabilities.Refresh()
            assert(not child:IsShown())
        end
        do
            ns.Chat.MemoryAction = function(action, slot, key, text)
                UI_TEST.memoryAction = { action = action, slot = slot, key = key, text = text }
            end
            ns.memory = {
                status = "available",
                entries = {
                    { slot = "character", key = "guide", text = "Following Guide A" },
                },
            }
            ns.UI.Memory.Refresh()
            local row
            for _, w in ipairs(UI_TEST.widgets) do
                if w.entry and w.entry.key == "guide" then
                    row = w
                end
            end
            assert(
                row and row.text:GetText() == "Following Guide A",
                "saved plans must be visible in Settings"
            )
            row.edit.scripts.OnClick()
            assert(UI_TEST.popup.id == "WISPAI_EDIT_MEMORY")
            StaticPopupDialogs.WISPAI_EDIT_MEMORY.OnAccept({
                editBox = {
                    GetText = function()
                        return "Following Guide B"
                    end,
                },
            }, row.entry)
            assert(
                UI_TEST.memoryAction.action == "save"
                    and UI_TEST.memoryAction.text == "Following Guide B"
            )
            row.remove.scripts.OnClick()
            assert(
                UI_TEST.memoryAction.action == "remove"
                    and UI_TEST.memoryAction.key == "guide"
                    and UI_TEST.memoryAction.slot == "character"
            )
            ns.memory = { status = "available", entries = {} }
            ns.UI.Memory.Refresh()
            assert(not row:IsShown(), "forgotten entries must disappear")
        end
        do
            local fold = UI_TEST.frames.WispAISidebarToggle
            local sidebar = UI_TEST.frames.WispAISidebar
            local gear = UI_TEST.frames.WispAISettingsButton
            local tabs = {}
            for _, widget in ipairs(UI_TEST.widgets) do
                if
                    widget.parent == sidebar
                    and (widget:GetText() == "New chat" or widget:GetText() == "Routines")
                then
                    tabs[#tabs + 1] = widget
                end
            end
            assert(#tabs == 2 and tabs[1]:IsVisible() and tabs[2]:IsVisible())
            for _, widget in ipairs(UI_TEST.widgets) do
                assert(
                    widget.parent ~= sidebar or widget:GetText() ~= "Chats",
                    "Recents is the way back to a chat; there is no separate Chats section"
                )
            end
            assert(
                gear.parent.parent == sidebar,
                "settings must live in the sidebar footer, beside the character"
            )
            assert(gear:GetText() == "", "settings uses an icon instead of a text label")
            assert(
                fold.parent == UI_TEST.frames.WispAIHeader,
                "the sidebar toggle leads the title bar, so it never hangs off the sidebar"
            )
            fold.scripts.OnClick()
            assert(
                not ns.db.sidebar and not sidebar:IsShown() and fold:IsVisible(),
                "collapsing hides the whole sidebar and keeps the toggle in the title bar"
            )
            assert(
                not tabs[1]:IsVisible() and not tabs[2]:IsVisible(),
                "collapsed sidebar must hide both tabs so they cannot overlap the conversation"
            )
            fold.scripts.OnClick()
            assert(ns.db.sidebar and sidebar:IsShown())
            local grip = UI_TEST.frames.WispAISidebarResize
            local cursor = 100
            function GetCursorPosition()
                return cursor, 0
            end
            sidebar:GetParent():SetWidth(700)
            ns.UI.Refresh()
            grip.scripts.OnMouseDown(grip)
            cursor = 160
            grip.scripts.OnUpdate(grip)
            assert(sidebar:GetWidth() == 250, "dragging the edge widens the sidebar")
            cursor = -1000
            grip.scripts.OnUpdate(grip)
            assert(sidebar:GetWidth() == 150, "the sidebar keeps a minimum width")
            sidebar:GetParent():SetWidth(500)
            cursor = 1000
            grip.scripts.OnUpdate(grip)
            assert(sidebar:GetWidth() == 200, "the conversation always keeps its own width")
            grip.scripts.OnMouseUp(grip)
            ns.db.sidebarWidth = nil
            ns.UI.Refresh()
            assert(
                tabs[1]:IsVisible() and tabs[2]:IsVisible(),
                "expanding the sidebar must restore both tabs"
            )
            ns.UI.SetMinimized(true)
            assert(
                UI_TEST.frames.WispAIWindow:GetWidth() == 240
                    and not fold:IsShown()
                    and not gear:IsShown(),
                "minimized bar must be compact and hide secondary controls"
            )
            local bar = UI_TEST.frames.WispAIHeader
            bar.scripts.OnMouseDown(bar, "LeftButton")
            bar.scripts.OnDragStart(bar)
            bar.scripts.OnDragStop(bar)
            bar.scripts.OnMouseUp(bar, "LeftButton")
            assert(ns.db.minimized, "dragging the minimized bar only moves it")
            bar.scripts.OnMouseDown(bar, "LeftButton")
            bar.scripts.OnMouseUp(bar, "LeftButton")
            assert(not ns.db.minimized, "a click on the minimized bar restores the window")
            assert(fold:IsShown() and gear:IsShown(), "expanding must restore controls")
            local settingsPage = UI_TEST.frames.WispAISettingsPage
            local memoryPage = UI_TEST.frames.WispAIMemoryPanel
            gear.scripts.OnClick(gear)
            ns.UI.ShowSettings("memory")
            assert(settingsPage:IsShown() and memoryPage:IsShown())
            assert(not tabs[2]._wispSelected, "no section is current while Settings is open")
            tabs[2].scripts.OnClick(tabs[2])
            assert(
                not settingsPage:IsShown() and not memoryPage:IsShown(),
                "navigating away closes Settings and its subpages"
            )
            assert(UI_TEST.frames.WispAIRoutinesPage:IsShown())
            gear.scripts.OnClick(gear)
            assert(
                settingsPage:IsShown() and not memoryPage:IsShown(),
                "Settings reopens on General"
            )
            ns.UI.ShowSettings(nil)
            ns.sidebarTab, ns.routinesPage = "chats", false
            ns.UI.Refresh()
        end
        do
            local bar = UI_TEST.frames.WispAITranscriptScrollBar
            assert(bar and bar:IsShown())
            assert(bar.max > 100)
            local writes = UI_TEST.textWrites
            local hides = UI_TEST.hides
            ns.UI.Refresh()
            assert(UI_TEST.textWrites == writes, "unchanged snapshots must not replace text")
            assert(UI_TEST.hides == hides, "unchanged snapshots must not hide message rows")
            bar:SetValue(30)
            table.insert(
                ns.chats[1].messages,
                { id = "answer-1", role = "assistant", text = string.rep("New answer ", 100) }
            )
            ns.UI.Refresh()
            assert(bar:GetValue() == 30, "incoming content must not pull the reader to the bottom")
        end
        do
            local window = UI_TEST.frames.WispAIWindow
            window:ClearAllPoints()
            window:SetPoint("CENTER", UIParent, "CENTER", 100, 200)
            ns.UI.SetMinimized(true)
            window:ClearAllPoints()
            window:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 800, -600)
            ns.UI.SaveWindowPosition(true)
            ns.UI.SetMinimized(false)
            local p, _, _, x, y = window:GetPoint()
            assert(
                p == "CENTER" and x == 100 and y == 200,
                "expanded position must survive moving the minimized bar"
            )
            ns.UI.SetMinimized(true)
            p, _, _, x, y = window:GetPoint()
            assert(
                p == "TOPLEFT" and x == 800 and y == -600,
                "minimized position must also be remembered"
            )
            ns.UI.SetMinimized(false)
            ns.UI.RequestDeleteChat("chat")
            assert(
                UI_TEST.popup and UI_TEST.popup.data == "chat",
                "deletion requires explicit confirmation"
            )
        end

        local progress = UI_TEST.frames.WispAIProgress
        assert(not progress:IsShown())
        ns.chats[1].status = "working"
        table.insert(ns.chats[1].messages, { id = "m", role = "user", text = "Sending test" })
        ns.pendingMessages = { m = { chat = "chat" } }
        ns.UI.Refresh()
        assert(not progress:IsShown(), "sending must not show an assistant progress row")
        ns.pendingMessages.m.acknowledged = true
        ns.UI.Refresh()
        assert(
            progress:IsShown() and progress.title:GetText():match("^Thinking"),
            "an acknowledged message should show an assistant thinking row"
        )
        ns.chats[1].activity = { { label = "Searching the web", status = "running" } }
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
        ns.chats[1].status = "done"
        ns.UI.Refresh()
        assert(not progress:IsShown(), "completion must clear the busy indicator")
        ns.chats[1].status = "working"
        UI_TEST.now = 80
        ns.UI.Refresh()
        assert(progress.elapsed:GetText() == "0s", "a new turn must restart the timer")
    end
)

it("macro references show the actual code and pick up by current name without executing", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    do
        ns = helper.namespace({
            db = { sidebar = true, showTools = true, drafts = {} },
            active = "chat",
            connected = true,
        })
        ns.chats = {
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
        function ns.Chat.Current()
            return ns.chats[1]
        end
        function ns.Core.Log(text)
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
    end
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    local row
    for _, w in ipairs(UI_TEST.widgets) do
        if w.scripts.OnHyperlinkEnter and type(w.text) == "table" then
            row = w
        end
    end
    assert(row.text:GetText():find("|Hwispmacro:4e6f7661|h[Nova]|h", 1, true))
    row.scripts.OnHyperlinkEnter(row, "wispmacro:4e6f7661", "[Nova]")
    assert(GameTooltip:GetText() == "Nova")
    row.scripts.OnHyperlinkClick(row, "wispmacro:4e6f7661", "[Nova]", "LeftButton")
    assert(UI_TEST.pickedMacro == 121)
    combat = true
    UI_TEST.pickedMacro = nil
    row.scripts.OnHyperlinkClick(row, "wispmacro:4e6f7661", "[Nova]", "LeftButton")
    assert(UI_TEST.pickedMacro == nil and UI_TEST.notice:find("combat"))
end)

it(
    "structured skill replies use the declared skill and map references support hover and native clicks",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace({
                db = { sidebar = true, showTools = true, drafts = {} },
                active = "chat",
                connected = true,
            })
            ns.chats = {
                {
                    id = "chat",
                    title = "References",
                    status = "done",
                    messages = {
                        {
                            id = "question",
                            role = "user",
                            text = "|cff71d5ff|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h|r?",
                        },
                        {
                            id = "reply",
                            role = "assistant",
                            references = {
                                skill = {
                                    kind = "spell",
                                    id = 11070,
                                    payload = "spell:11070:0",
                                    label = "Descarga de Escarcha mejorada",
                                },
                                zone = { kind = "map", mapId = 1411, label = "Durotar" },
                                ramp = {
                                    kind = "map",
                                    mapId = 1411,
                                    x = 45,
                                    y = 62.5,
                                    label = "Rampa",
                                },
                            },
                            text = "Sí, [[ref:skill]]. Descarga de Escarcha mejoradaExtra. `Descarga de Escarcha mejorada` [[ref:zone]] [[ref:ramp]]",
                        },
                    },
                },
            }
            function ns.Chat.Current()
                return ns.chats[1]
            end
            C_Map = {
                GetMapInfo = function()
                    return { name = "Durotar" }
                end,
                OpenWorldMap = function(id)
                    UI_TEST.openedMap = id
                end,
            }
        end
        helper.addon("UI/Window.lua", env)
        ns.UI.BuildUI()
        local row
        for _, w in ipairs(UI_TEST.widgets) do
            if
                w.scripts.OnHyperlinkEnter
                and type(w.text) == "table"
                and helper.rowText(w):find("Rampa", 1, true)
            then
                row = w
            end
        end
        assert(row)
        local text = helper.rowText(row)
        assert(
            text:find("|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h", 1, true),
            "plain text must reuse the exact skill link supplied by the user"
        )
        local _, count = text:gsub("|Hspell:", "")
        assert(count == 1, "code spans and larger words must not be auto-linked")
        assert(text:find("|Hwispzone:1411|h[Durotar]|h", 1, true))
        assert(
            text:find("|Hworldmap:1411:4500:6250|h[Rampa (45.0, 62.5)]|h", 1, true),
            "map percentages must become native 0–10000 coordinates"
        )
        row.scripts.OnHyperlinkEnter(row, "worldmap:1411:4500:6250", "[Rampa]")
        assert(GameTooltip:GetText() == "Durotar")
        row.scripts.OnHyperlinkClick(row, "worldmap:1411:4500:6250", "[Rampa]", "LeftButton")
        assert(UI_TEST.clickedLink == "worldmap:1411:4500:6250")
        row.scripts.OnHyperlinkClick(row, "wispzone:1411", "[Durotar]", "LeftButton")
        assert(UI_TEST.openedMap == 1411)
        ns.chats[1].messages[2].references.ramp.x = 46
        ns.UI.Refresh()
        assert(
            helper.rowText(row):find("worldmap:1411:4600:6250", 1, true),
            "late reference changes must update the existing row even when the text is unchanged"
        )
    end
)

it(
    "prose around generated cards keeps spell and item hover, clicks and scrolling on its own frame",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace()
        end
        helper.addon("UI/Window.lua", env)
        helper.addon("UI/RichUI.lua", env)

        local spell = "Use [[ref:spell]] first."
        local item = "Keep [[ref:item]] equipped."
        local message = {
            id = "reply",
            role = "assistant",
            text = spell .. "\n" .. item,
            references = {
                spell = { kind = "spell", id = 2137, label = "Explosión de Fuego" },
                item = {
                    kind = "item",
                    id = 1733,
                    payload = "item:1733:0",
                    label = "Capa desgastada",
                },
            },
            ui = { { id = "result", kind = "stat", label = "DPS", value = "31.2" } },
            parts = {
                { type = "text", text = spell },
                { type = "ui", id = "result" },
                { type = "text", text = item },
            },
        }
        local chat = { id = "chat", status = "done", messages = { message } }
        local row = ns.UI.MakeMessageRow(CreateFrame("Frame"))
        ns.UI.RenderMessageRow(row, chat, message, 500, true)
        assert(
            not row.text:IsShown(),
            "interleaved replies use the rich prose, not the ordinary row text"
        )
        local first, second = row.rich.prose[1], row.rich.prose[2]
        assert(helper.rendered(first):find("|Hspell:2137|h[Explosión de Fuego]|h", 1, true))
        assert(helper.rendered(second):find("|Hitem:1733:0|h[Capa desgastada]|h", 1, true))
        for _, entry in ipairs({ { first, "spell:2137" }, { second, "item:1733:0" } }) do
            local owner, link = entry[1]:GetParent(), entry[2]
            assert(
                owner.mouseEnabled and owner.hyperlinksEnabled and owner.scripts.OnHyperlinkEnter,
                "the frame owning visible prose must receive hyperlink events"
            )
            owner.scripts.OnHyperlinkEnter(owner, link, "[Reference]")
            assert(
                GameTooltip:IsShown()
                    and UI_TEST.tooltipLink == link
                    and ns.hoverLink == "[Reference]"
            )
            owner.scripts.OnHyperlinkLeave(owner)
            assert(not GameTooltip:IsShown() and ns.hoverLink == nil)
            owner.scripts.OnHyperlinkClick(owner, link, "[Reference]", "LeftButton")
            assert(UI_TEST.clickedLink == link)
        end
        local scrolled
        ns.UI.ScrollTranscript = function(delta)
            scrolled = delta
        end
        first:GetParent().scripts.OnMouseWheel(first:GetParent(), -1)
        assert(scrolled == -1, "interactive prose must preserve transcript scrolling")
        local owner = first:GetParent()
        ns.UI.RenderMessageRow(row, chat, message, 230, true)
        assert(row.rich.prose[1] == first and first:GetParent() == owner)
        assert(owner.scripts.OnHyperlinkEnter, "resize must keep the interactive owner")
    end
)

it(
    "verified references support hover and quest clicks without reserving transcript space for progress",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace({
                db = { sidebar = true, showTools = true, drafts = {} },
                active = "chat",
                connected = true,
            })
            ns.chats = {
                {
                    id = "chat",
                    title = "Links",
                    status = "idle",
                    messages = {
                        {
                            id = "reply",
                            role = "assistant",
                            references = {
                                quest = {
                                    kind = "quest",
                                    id = 12,
                                    payload = "quest:12:10",
                                    label = "Las arpías",
                                },
                                nova = { kind = "spell", id = 122, label = "Nova" },
                                robe = { kind = "item", id = 100, label = "Robe" },
                                other = { kind = "quest", id = 99, label = "Other quest" },
                                native = {
                                    kind = "item",
                                    id = 200,
                                    payload = "item:200:0",
                                    label = "Native robe",
                                },
                            },
                            text = "Finish [[ref:quest]]. [[ref:nova]], [[ref:robe]], [[ref:other]]. Unknown Quest. [[ref:native]]",
                        },
                    },
                },
            }
            function ns.Chat.Current()
                return ns.chats[1]
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
        end
        helper.addon("UI/Window.lua", env)
        ns.UI.BuildUI()

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
        function ns.draft:Insert(text)
            UI_TEST.insertedLink = text
        end
        row.scripts.OnHyperlinkClick(
            row,
            "quest:12:10",
            "|Hquest:12:10|h[Las arpías]|h",
            "LeftButton"
        )
        assert(UI_TEST.insertedLink:find("|Hquest:12:10", 1, true))
        local progress = UI_TEST.frames.WispAIProgress
        assert(
            progress.parent == row.parent
                and progress.parent ~= ns.draft.parent
                and progress.mark ~= nil,
            "progress belongs in the transcript as an assistant row led by Wisp's mark"
        )
        local bar = UI_TEST.frames.WispAITranscriptScrollBar
        local _, _, _, _, bottom = bar:GetPoint()
        -- The transcript ends 6 above an empty one-line composer: 40 field + 30 row + 14 margin.
        assert(bottom == 90, "there must be no additional reserved progress gap")
        table.insert(ns.chats[1].messages, { id = "next", role = "user", text = "What next?" })
        ns.chats[1].status = "working"
        ns.UI.Refresh()
        assert(
            progress:IsShown()
                and progress.parent:GetHeight() == progress.y + progress:GetHeight()
                and #ns.chats[1].messages == 2,
            "thinking occupies transcript space without becoming a saved message"
        )
        ns.chats[1].status = "done"
        ns.UI.Refresh()
        assert(
            not progress:IsShown() and progress.parent:GetHeight() == progress.y - 12,
            "completion removes the transient row and its space"
        )
    end
)
