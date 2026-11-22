local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    do
        ns = helper.namespace()
        SlashCmdList = {}
        function time()
            return 1
        end
    end
    helper.addon("Core.lua", env)
    helper.addon("UI/RichUI.lua", env)
    helper.addon("UI/Window.lua", env)
    helper.addon("Inline/Inline.lua", env)
    helper.addon("Api/Api.lua", env)
    do
        ns.db = { sidebar = true, minimized = true, showTools = true, drafts = {} }
        ns.connected = true
        ns.active = "main"
        ns.chats =
            { { id = "main", title = "Main", messages = {}, status = "idle", activity = {} } }
        packets = {}
        function ns.Transport.Send(p)
            packets[#packets + 1] = p
        end
        function ns.Transport.Acknowledge() end
        function ns.Core.Log(t)
            notice = t
        end
        function ns.Character.Capture(sections)
            return { fresh = true, sections = sections }
        end
        ns.UI.BuildUI()
        ns.Inline.InitInline()
        UI_TEST.now = 100
    end
end

-- Tests run in an isolated environment; read the packets recorded in the caller's.
local function sent(kind)
    local found
    for _, packet in ipairs(getfenv(2).packets) do
        if packet.type == kind then
            found = packet
        end
    end
    return found
end

local FIGHT = { label = "Last fight", text = "Damage | 1200\nDeaths | 0" }

it("Ask opens the popup prefilled, sends nothing, and sends the attachment on Enter", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(WispAI.API_VERSION == 1 and WispAI.IsAvailable() == true)
    local ok, reason = WispAI.Ask({
        source = "MyMeter",
        prompt = "Review my last fight",
        attachment = FIGHT,
    })
    assert(ok == true and reason == nil)
    local panel, input = UI_TEST.frames.WispAIInline, UI_TEST.frames.WispAIInlineInput
    local chip = UI_TEST.frames.WispAIInlineAttachment
    assert(panel:IsShown() and input:GetText() == "Review my last fight")
    assert(chip:IsShown(), "the player sees what is attached")
    assert(chip.label:GetText():find("MyMeter · Last fight · ", 1, true))
    assert(sent("inline_say") == nil, "Ask never sends on its own")
    assert(ns.active == "main", "the main conversation stays selected")

    ns.Inline.SendInline()
    local packet = sent("inline_say")
    assert(packet and packet.text == "Review my last fight")
    assert(packet.attachment.source == "MyMeter" and packet.attachment.label == "Last fight")
    assert(packet.attachment.text == FIGHT.text, "attachment data keeps its pipes")
    local message = ns.Inline.InlineCurrent().messages[1]
    assert(message.attachment.source == "MyMeter" and message.attachment.text == nil)
    assert(not chip:IsShown(), "the attachment goes with the first question only")

    ns.Inline.InlineCurrent().status = "done"
    input:SetText("And my rotation?")
    ns.Inline.SendInline()
    assert(packets[#packets].type == "inline_say" and packets[#packets].attachment == nil)
end)

it("Ask defaults the title to the source and shows a link as the reference", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local link = "|cff1eff00|Hitem:100:0|h[Robe]|h|r"
    assert(WispAI.Ask({ source = "MyBags", prompt = "Is this an upgrade?", link = link }))
    assert(UI_TEST.frames.WispAIInlineInput:GetText() == "Is this an upgrade?")
    assert(UI_TEST.frames.WispAIInline.reference == link)
    assert(not UI_TEST.frames.WispAIInlineAttachment:IsShown())
    ns.Inline.SendInline()
    local packet = sent("inline_say")
    assert(packet.text == "Is this an upgrade?\n\n" .. link and packet.attachment == nil)
end)

it("Ask rejects invalid requests without opening anything", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local invalid = {
        "not a table",
        {},
        { source = "" },
        { source = "   " },
        { source = 7 },
        { source = string.rep("a", 41) },
        { source = "A" },
        { source = "A", prompt = "  " },
        { source = "A", prompt = string.rep("a", 501) },
        { source = "A", prompt = "P", title = string.rep("a", 61) },
        { source = "A", prompt = "P", link = "plain text" },
        { source = "A", prompt = "P", link = "|Hitem:1|h[A]|h and more" },
        { source = "A", prompt = "P", attachment = "text" },
        { source = "A", prompt = "P", attachment = { text = "x" } },
        { source = "A", prompt = "P", attachment = { label = "L", text = "" } },
        { source = "A", prompt = "P", attachment = { label = "L", text = string.rep("a", 4001) } },
        { source = "A", prompt = "P", attachment = { label = string.rep("a", 61), text = "x" } },
    }
    for index, request in ipairs(invalid) do
        local ok, reason = WispAI.Ask(request)
        assert(ok == false and reason == "invalid_request", "request " .. index)
    end
    assert(not UI_TEST.frames.WispAIInline:IsShown())
    assert(WispAI.Ask({
        source = "A",
        prompt = "P",
        attachment = { label = "L", text = string.rep("a", 4000) },
    }))
end)

it("Ask strips WoW markup from what it displays", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(WispAI.Ask({
        source = "|cffff0000Evil|r|TInterface\\Icons\\x:0|t",
        title = "|Hitem:1|h[Fake]|h",
        prompt = "Line one\nline two",
        attachment = { label = "|cff00ff00Green|r", text = "a\r\nb\0c" },
    }))
    local chip = UI_TEST.frames.WispAIInlineAttachment
    assert(chip.label:GetText():find("^Evil · Green · "), chip.label:GetText())
    assert(UI_TEST.frames.WispAIInlineInput:GetText() == "Line one line two")
    ns.Inline.SendInline()
    local attachment = sent("inline_say").attachment
    assert(attachment.source == "Evil" and attachment.label == "Green")
    assert(attachment.text == "a\nbc")
end)

it("Ask reports unavailable, busy and throttled without touching the popup", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    ns.connected = false
    assert(select(2, WispAI.Ask({ source = "A", prompt = "P" })) == "unavailable")
    assert(WispAI.IsAvailable() == false)
    ns.connected = true
    ns.Transport.needsDesktopSetup = true
    assert(select(2, WispAI.Ask({ source = "A", prompt = "P" })) == "unavailable")
    ns.Transport.needsDesktopSetup = false

    assert(WispAI.Ask({ source = "A", prompt = "First" }))
    assert(select(2, WispAI.Ask({ source = "B", prompt = "Second" })) == "throttled")
    UI_TEST.now = UI_TEST.now + 1
    assert(WispAI.Ask({ source = "B", prompt = "Second" }), "an untouched prefill is replaced")

    local input = UI_TEST.frames.WispAIInlineInput
    input:SetText("My own question")
    UI_TEST.now = UI_TEST.now + 1
    assert(select(2, WispAI.Ask({ source = "C", prompt = "P" })) == "busy")
    assert(input:GetText() == "My own question", "the player's text is never overwritten")

    ns.Inline.SendInline()
    UI_TEST.now = UI_TEST.now + 1
    assert(
        select(2, WispAI.Ask({ source = "C", prompt = "P" })) == "busy",
        "a question is being answered"
    )
end)

it("a hovered reference replaces an Ask session and its attachment", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(WispAI.Ask({ source = "MyMeter", prompt = "Review", attachment = FIGHT }))
    GameTooltip.GetItem = function()
        return "Robe", "|cff00ff00|Hitem:100:0|h[Robe]|h|r"
    end
    GameTooltip:Show()
    ns.Inline.OpenInline()
    assert(not UI_TEST.frames.WispAIInlineAttachment:IsShown())
    assert(UI_TEST.frames.WispAIInlineInput:GetText() == "")
    UI_TEST.frames.WispAIInlineInput:SetText("Good?")
    ns.Inline.SendInline()
    assert(sent("inline_say").attachment == nil)
end)

it("a user message names the addon its attachment came from", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(WispAI.Ask({ source = "MyMeter", prompt = "Review my fight", attachment = FIGHT }))
    ns.Inline.SendInline()
    local found
    for _, row in ipairs(UI_TEST.widgets) do
        local text = type(row.text) == "table" and row.text:GetText()
        if type(text) == "string" and text:find("Review my fight", 1, true) then
            found = text
        end
    end
    assert(found and found:find("MyMeter · Last fight", 1, true), found)
end)
