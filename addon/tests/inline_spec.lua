local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    do
        C = {}
        SlashCmdList = {}
        function time()
            return 1
        end
    end
    helper.addon("Core.lua", env)
    helper.addon("RichUI.lua", env)
    helper.addon("UI.lua", env)
    helper.addon("Inline.lua", env)
    do
        C.db = { sidebar = true, minimized = true, showTools = true, drafts = {} }
        C.connected = true
        C.active = "main"
        C.chats = { { id = "main", title = "Main", messages = {}, status = "idle", activity = {} } }
        packets = {}
        function C.Send(p)
            packets[#packets + 1] = p
        end
        function C.Acknowledge() end
        function C.Log(t)
            notice = t
        end
        function C.Capture(sections)
            return { fresh = true, sections = sections }
        end
        C_EncodingUtil = {
            DeserializeJSON = function(t)
                return t
            end,
        }
        C.BuildUI()
        C.InitInline()
        GameTooltip.GetItem = function()
            return "Robe", "|cff00ff00|Hitem:100:0|h[Robe]|h|r"
        end
        GameTooltip:Show()
    end
end

it(
    "chat model controls select account options, wait for confirmation and isolate conversations",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        C.modelCatalog = {
            defaultModel = "luna",
            models = {
                {
                    slug = "luna",
                    displayName = "Luna",
                    efforts = { "low", "medium", "high" },
                    defaultEffort = "low",
                },
                {
                    slug = "sol",
                    displayName = "Sol",
                    efforts = { "low", "medium", "max", "ultra" },
                    defaultEffort = "low",
                },
            },
        }
        local options = {}
        MenuUtil = {
            CreateContextMenu = function(_, build)
                options = {}
                build(nil, {
                    CreateTitle = function() end,
                    CreateRadio = function(_, label, selected, choose)
                        options[label] = { selected = selected, choose = choose }
                    end,
                })
            end,
        }
        C.Refresh()
        local controls = UI_TEST.frames.WispAIChatModelControls
        assert(controls.model:GetText() == "Luna" and controls.effort:GetText() == "Effort: medium")
        controls.model.scripts.OnClick(controls.model)
        assert(options.Luna.selected())
        options.Sol.choose()
        local packet = packets[#packets]
        assert(
            packet.type == "chat_model_set" and packet.chat == "main" and packet.data.model == "sol"
        )
        assert(not controls.model.enabled and controls.model:GetText() == "Saving...")
        C.draft:SetText("Wait")
        local count = #packets
        C.Submit()
        assert(#packets == count, "sending must wait until settings have been confirmed")
        local chat = C.Current()
        chat.modelSettings = { model = "sol", effort = "medium" }
        chat.modelRequestId = packet.requestId
        C.Refresh()
        assert(not C.modelPending.main and controls.model:GetText() == "Sol")
        controls.effort.scripts.OnClick(controls.effort)
        assert(options.ultra and not options.high, "efforts come from the selected model")
        options.ultra.choose()
        assert(packets[#packets].data.effort == "ultra")
        chat.modelRequestId = packets[#packets].requestId
        chat.modelSettings.effort = "ultra"
        C.Refresh()
        chat.status = "working"
        C.Refresh()
        assert(not controls.model.enabled and not controls.effort.enabled)
        chat.status = "done"
        C.OpenInline()
        local inline = UI_TEST.frames.WispAIInlineModelControls
        inline.model.scripts.OnClick(inline.model)
        options.Sol.choose()
        packet = packets[#packets]
        assert(packet.data.inline and packet.chat == C.inlineId and packet.chat ~= "main")
        assert(
            chat.modelSettings.effort == "ultra",
            "inline choices must not mutate the main conversation"
        )
    end
)

it("API reasoning defaults, toggle labels, and inline effort remain conversation-scoped", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C.modelCatalog = {
        defaultModel = "api",
        models = {
            {
                slug = "api",
                displayName = "API",
                efforts = { "provider-default", "none", "low", "medium", "high" },
                defaultEffort = "provider-default",
            },
            {
                slug = "toggle",
                displayName = "Toggle",
                efforts = { "provider-default", "none", "enabled" },
                defaultEffort = "provider-default",
            },
        },
    }
    local options = {}
    MenuUtil = {
        CreateContextMenu = function(_, build)
            options = {}
            build(nil, {
                CreateTitle = function() end,
                CreateRadio = function(_, label, selected, choose)
                    options[label] = { selected = selected, choose = choose }
                end,
            })
        end,
    }
    C.Refresh()
    local controls = UI_TEST.frames.WispAIChatModelControls
    assert(controls.effort:GetText() == "Effort: Default")
    controls.effort.scripts.OnClick(controls.effort)
    assert(options.Default.selected() and not options.medium.selected())
    options.high.choose()
    local packet = packets[#packets]
    assert(packet.data.effort == "high" and packet.chat == "main")
    local chat = C.Current()
    chat.modelSettings = { model = "api", effort = "high" }
    chat.modelRequestId = packet.requestId
    C.Refresh()
    C.OpenInline()
    local inline = UI_TEST.frames.WispAIInlineModelControls
    inline.model.scripts.OnClick(inline.model)
    options.Toggle.choose()
    packet = packets[#packets]
    local inlineChat = C.InlineCurrent()
    inlineChat.modelSettings = { model = "toggle", effort = "provider-default" }
    inlineChat.modelRequestId = packet.requestId
    C.Refresh()
    inline.effort.scripts.OnClick(inline.effort)
    assert(options.On and options.Off and options.Default)
    options.On.choose()
    packet = packets[#packets]
    assert(packet.data.effort == "enabled" and packet.chat == C.inlineId)
    assert(chat.modelSettings.effort == "high")
end)

it("inline item questions preserve named quality colors and full item payloads", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local link = "|cnIQ2:|Hitem:275067::::::::12:1482:::::::::|h[Pergamino de Imbuir gelidaga]|h|r"
    GameTooltip.GetItem = function()
        return "Pergamino de Imbuir gelidaga", link
    end
    C.OpenInline()
    UI_TEST.frames.WispAIInlineInput:SetText("Vale la pena usar esto?")
    C.SendInline()
    local chat = C.InlineCurrent()
    assert(chat.messages[1].text == "Vale la pena usar esto?\n\n" .. link)
    local found
    for _, row in ipairs(UI_TEST.widgets) do
        if
            row.scripts.OnHyperlinkEnter
            and type(row.text) == "table"
            and row.text:GetText():find("Vale la pena", 1, true)
        then
            found = row
        end
    end
    assert(
        found and found.text:GetText() == chat.messages[1].text,
        "quality color markup must not become visible text"
    )
    assert(not found.text:GetText():find("||", 1, true))
    local payload = "item:275067::::::::12:1482:::::::::"
    found.scripts.OnHyperlinkEnter(found, payload, "[Pergamino de Imbuir gelidaga]")
    assert(UI_TEST.tooltipLink == payload, "hover must retain the exact item variant")
    assert(
        C.FormatText(
            "|cnIQ1:|Hitem:2901::::::::12:1482::14:::::::|h[Pico de minero]|h|r",
            nil,
            true
        ) == "|cnIQ1:|Hitem:2901::::::::12:1482::14:::::::|h[Pico de minero]|h|r"
    )
    assert(
        C.FormatText("Code: `" .. link .. "`", nil, true):find("||cnIQ2:", 1, true),
        "code stays literal"
    )
    assert(
        C.FormatText(link, nil, false):find("||cnIQ2:", 1, true),
        "assistant output still requires declared references"
    )
end)

it("a completed reply lights the minimized window until it is opened", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local glow = UI_TEST.frames.WispAIReplyGlow
    local sounds = 0
    C.db.sound = true
    SOUNDKIT = { TELL_MESSAGE = 3081 }
    function PlaySound(id, channel)
        assert(id == SOUNDKIT.TELL_MESSAGE and channel == "Master")
        sounds = sounds + 1
    end
    assert(not glow:IsShown())
    C.chats[1].status = "working"
    C.Refresh()
    assert(not glow:IsShown(), "working is not a completed reply")
    local function completed(rev)
        WispAI_Receive({
            v = C.VERSION,
            session = C.session,
            rev = rev,
            connected = true,
            chats = {
                { id = "main", title = "Main", status = "done", messages = {}, activity = {} },
            },
        })
    end
    completed(1)
    assert(C.unread and glow:IsShown())
    assert(sounds == 1)
    assert(glow.mouseEnabled == false, "the glow must not block dragging or expanding")
    completed(2)
    assert(glow:IsShown(), "later snapshots must preserve the unread notification")
    assert(sounds == 1, "snapshots must not replay the sound")
    C.SetMinimized(false)
    assert(not C.unread and not glow:IsShown())
    C.SetMinimized(true)
    assert(not glow:IsShown(), "minimizing again must not relight a read reply")
    C.SetMinimized(false)
    C.chats[1].status = "working"
    completed(3)
    assert(not C.unread and not glow:IsShown(), "visible replies do not notify")
    assert(sounds == 2)
    C.db.sound = false
    C.chats[1].status = "working"
    completed(4)
    assert(sounds == 2, "the sound setting must be respected")
end)

it(
    "hover shortcut opens an inline query without switching or expanding the main chat, survives stale snapshots, and promotes on demand",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        C.OpenInline()
        assert(C.active == "main" and C.db.minimized and C.inlineId == nil)
        local input = UI_TEST.frames.WispAIInlineInput
        input:SetText("Is this good?")
        C.SendInline()
        local id = C.inlineId
        local packet = packets[#packets]
        assert(
            packet.type == "inline_say"
                and packet.chat == id
                and packet.text:find("|Hitem:100:0", 1, true)
                and packet.context.fresh
                and C.active == "main"
        )
        assert(#C.InlineCurrent().messages == 1 and C.InlineCurrent().status == "working")
        WispAI_Receive({
            v = 1,
            session = C.session,
            rev = 1,
            connected = true,
            chats = { { id = "main", title = "Main", messages = {}, status = "idle" } },
        })
        assert(
            C.InlineCurrent() and C.InlineCurrent().messages[1].text == packet.text,
            "stale snapshots must retain the optimistic inline message"
        )
        local quick = C.InlineCurrent()
        quick.status = "done"
        quick.messages[2] = {
            id = "answer",
            role = "assistant",
            text = "Yes",
            ui = {
                { id = "card", kind = "card", title = "Equipment" },
                { id = "armor", parent = "card", kind = "stat", label = "Armor", value = "12" },
            },
        }
        C.RefreshInline()
        assert(UI_TEST.frames.WispAIInline:IsShown())
        local expand
        for _, w in ipairs(UI_TEST.widgets) do
            if w:GetText() == "Expand" then
                expand = w
            end
        end
        expand.scripts.OnClick()
        assert(
            C.active == id
                and not C.db.minimized
                and not quick.inline
                and not UI_TEST.frames.WispAIInline:IsShown()
        )
        local found = false
        for _, p in ipairs(packets) do
            if p.type == "promote_inline" and p.chat == id then
                found = true
            end
        end
        assert(found)
    end
)

it(
    "reference capture supports spells and units and binding setup preserves existing shortcuts",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        GameTooltip.GetItem = function() end
        GameTooltip.GetSpell = function()
            return "Nova", 122
        end
        assert(C.CaptureHover():find("spell:122", 1, true))
        GameTooltip.GetSpell = function() end
        GameTooltip.GetUnit = function()
            return "Wolf", "mouseover"
        end
        function UnitGUID(unit)
            assert(unit == "mouseover")
            return "Creature-0-1-2-3-4-5"
        end
        assert(C.CaptureHover():find("unit:Creature-", 1, true))
        bindings = { ["CTRL-Q"] = "OTHER_ACTION" }
        function GetBindingAction(key)
            return bindings[key] or ""
        end
        function GetBindingKey()
            return "CTRL-J"
        end
        function SetBinding(key, value)
            bindings[key] = value
            return true
        end
        function SaveBindings()
            saved = true
        end
        function GetCurrentBindingSet()
            return 1
        end
        function IsControlKeyDown()
            return true
        end
        function IsAltKeyDown()
            return false
        end
        C.BindInline()
        local dialog
        for _, w in ipairs(UI_TEST.widgets) do
            if w.scripts.OnKeyDown and w ~= UI_TEST.frames.WispAIWindow then
                dialog = w
            end
        end
        dialog.scripts.OnKeyDown(dialog, "Q")
        assert(bindings["CTRL-Q"] == "OTHER_ACTION" and not saved)
        dialog.scripts.OnKeyDown(dialog, "H")
        assert(
            saved
                and bindings["CTRL-H"] == "WISPAI_INLINE"
                and C.db.inlineBinding == "CTRL-H"
                and not dialog:IsShown()
        )
    end
)

it("a mouse binding dispatches over bag UI and preserves the hovered item", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local base = { BUTTON4 = "WISPAI_INLINE", ["ALT-BUTTON5"] = "WISPAI_INLINE" }
    local overrides = {}
    local clears = 0
    local combat = false
    function InCombatLockdown()
        return combat
    end
    function IsControlKeyDown()
        return false
    end
    function IsAltKeyDown()
        return false
    end
    function IsShiftKeyDown()
        return false
    end
    function GetBindingKey()
        return "BUTTON4", "ALT-BUTTON5"
    end
    function GetBindingAction(key, check)
        return (check and overrides[key]) or base[key] or ""
    end
    function ClearOverrideBindings(owner)
        overrides = {}
        clears = clears + 1
    end
    function SetOverrideBindingClick(owner, priority, key, name, button)
        assert(owner == UI_TEST.frames.WispAIInlineHotkey and UI_TEST.frames[name] and priority)
        overrides[key] = "CLICK " .. name .. ":" .. button
    end
    C.db.inlineBinding = "BUTTON4"
    C.RefreshInlineBindings()
    assert(overrides.BUTTON4 == "CLICK WispAIInlineHotkey:LeftButton")
    local function event(name, button)
        for _, w in ipairs(UI_TEST.widgets) do
            if w.scripts.OnEvent then
                w.scripts.OnEvent(w, name, button)
            end
        end
    end
    local before = clears
    event("UPDATE_BINDINGS")
    assert(clears == before, "unchanged binding events must not rebuild overrides")
    event("GLOBAL_MOUSE_DOWN", "Button4")
    assert(UI_TEST.frames.WispAIInline:IsShown())
    assert(UI_TEST.frames.WispAIInline.reference == "|cff00ff00|Hitem:100:0|h[Robe]|h|r")
    local diagnostic = packets[#packets]
    assert(
        diagnostic.type == "inline_status"
            and diagnostic.data.panelShown
            and diagnostic.data.hasReference
    )
    before = #packets
    UI_TEST.frames.WispAIInlineHotkey.scripts.OnClick()
    assert(#packets == before, "global mouse and native click dispatch must not activate twice")
    C.CloseInline()
    UI_TEST.now = 1
    UI_TEST.frames.WispAIInlineHotkey.scripts.OnClick()
    assert(
        UI_TEST.frames.WispAIInline:IsShown(),
        "direct click target works without Bindings.xml dispatch"
    )
    C.CloseInline()
    base.BUTTON4 = "OTHER_ACTION"
    combat = true
    event("UPDATE_BINDINGS")
    assert(overrides.BUTTON4)
    combat = false
    event("PLAYER_REGEN_ENABLED")
    assert(not overrides.BUTTON4 and overrides["ALT-BUTTON5"])
    UI_TEST.now = 2
    event("GLOBAL_MOUSE_DOWN", "Button4")
    assert(not UI_TEST.frames.WispAIInline:IsShown(), "another action retains its mouse button")
end)

it(
    "inline binding captures mouse buttons and wheel with modifiers, conflicts and combat guards",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        bindings = { ["CTRL-J"] = "WISPAI_INLINE", ["ALT-SHIFT-BUTTON4"] = "OTHER_ACTION" }
        local saves = 0
        function GetBindingAction(key)
            return bindings[key] or ""
        end
        function GetBindingKey()
            return "CTRL-J"
        end
        function SetBinding(key, value)
            bindings[key] = value
            return true
        end
        function SaveBindings()
            saves = saves + 1
        end
        function GetCurrentBindingSet()
            return 1
        end
        function IsControlKeyDown()
            return false
        end
        function IsAltKeyDown()
            return true
        end
        function IsShiftKeyDown()
            return true
        end
        local combat = false
        function InCombatLockdown()
            return combat
        end
        local function open()
            C.BindInline()
            local dialog
            for _, w in ipairs(UI_TEST.widgets) do
                if w.scripts.OnKeyDown and w ~= UI_TEST.frames.WispAIWindow then
                    dialog = w
                end
            end
            return dialog
        end
        local dialog = open()
        local capture = dialog.parent
        assert(capture.mouseEnabled and dialog.mouseEnabled)
        capture.scripts.OnMouseDown(capture, "Button4")
        assert(saves == 0 and bindings["ALT-SHIFT-BUTTON4"] == "OTHER_ACTION" and dialog:IsShown())
        capture.scripts.OnMouseDown(capture, "Button5")
        assert(
            saves == 1
                and bindings["ALT-SHIFT-BUTTON5"] == "WISPAI_INLINE"
                and not bindings["CTRL-J"]
        )
        assert(C.db.inlineBinding == "ALT-SHIFT-BUTTON5" and not dialog:IsShown())
        dialog.scripts.OnHide()
        assert(not capture:IsShown())
        dialog = open()
        dialog.scripts.OnMouseWheel(dialog, -1)
        assert(saves == 2 and bindings["ALT-SHIFT-MOUSEWHEELDOWN"] == "WISPAI_INLINE")
        dialog = open()
        combat = true
        dialog.scripts.OnMouseDown(dialog, "MiddleButton")
        assert(saves == 2 and not bindings["ALT-SHIFT-BUTTON3"] and not dialog:IsShown())
        combat = false
        dialog = open()
        dialog.scripts.OnKeyDown(dialog, "ESCAPE")
        assert(saves == 2 and not dialog:IsShown())
    end
)
