local helper = require("addon.tests.support")

local function setupCapture(_ENV)
    do
        C = { db = { drafts = {} }, chats = {}, connected = false }
        now = 100
        function time()
            return now
        end
        function UnitName()
            return "Mage"
        end
        function C.Current()
            return nil
        end
        function C.Send() end
    end
    do
        function CreateFrame()
            return {
                RegisterEvent = function() end,
                SetScript = function(_, _, fn)
                    capture = fn
                end,
            }
        end
    end
    helper.addon("ChatHistory.lua", _ENV)
    do
        chatCapture = capture
    end
    helper.addon("Character.lua", _ENV)
    do
        capture = chatCapture
    end
end

local function setupUI(_ENV)
    helper.fixture("addon/tests/wow-ui-stub.lua", _ENV)
    do
        C = { db = { drafts = {} }, chats = {}, connected = false }
        now = 100
        function time()
            return now
        end
        function UnitName()
            return "Mage"
        end
        function C.Current()
            return nil
        end
        function C.Send() end
    end
    helper.addon("ChatHistory.lua", _ENV)
    helper.addon("UI.lua", _ENV)
end

it("chat buffer bounds, filters, expiry, disabling and clearing are enforced", function()
    local _ENV = helper.env()
    setupCapture(_ENV)

    assert(C.ChatChannelEnabled("party") and not C.ChatChannelEnabled("whisper"))
    capture(nil, "CHAT_MSG_WHISPER", "private", "Friend")
    capture(nil, "CHAT_MSG_ADDON", "internal", "Addon")
    assert(C.ReadChatHistory({}).count == 0)
    capture(nil, "CHAT_MSG_PARTY_LEADER", "Pull in 5", "Leader")
    now = 101
    capture(nil, "CHAT_MSG_GUILD", "|cff00ff00|Hitem:123|h[Item]|h|r", "Guildmate")
    local result = C.Inspect({ kind = "chat", args = {} })
    assert(result.status == "available" and result.data.count == 2)
    assert(result.data.messages[1].event == "CHAT_MSG_PARTY_LEADER")
    assert(result.data.messages[2].text == "[Item]")
    local party = C.ReadChatHistory({ channels = { "party" }, sender = "lead", query = "PULL" })
    assert(party.count == 1 and party.messages[1].sender == "Leader")
    C.SetPublicChatChannel("Trade", true)
    capture(
        nil,
        "CHAT_MSG_CHANNEL",
        "LFM healer",
        "Recruiter",
        nil,
        "2. Trade",
        nil,
        nil,
        nil,
        2,
        "Trade"
    )
    assert(C.ReadChatHistory({ channelName = "trade" }).count == 1)
    assert(C.ReadChatHistory({ channelName = "General" }).count == 0)
    C.SetChatChannel("whisper", true)
    capture(nil, "CHAT_MSG_WHISPER_INFORM", "hello", "Friend")
    assert(C.ReadChatHistory({ channels = { "whisper" } }).messages[1].direction == "outgoing")
    C.SetChatChannel("whisper", false)
    C.SetChatChannel("whisper", true)
    assert(C.ReadChatHistory({ channels = { "whisper" } }).count == 0)
    C.ClearChatHistory()
    for i = 1, 205 do
        capture(nil, "CHAT_MSG_PARTY", tostring(i), "Leader")
    end
    local bounded = C.ReadChatHistory({ limit = 50 })
    assert(bounded.retainedCount == 200 and bounded.count == 50 and bounded.truncated)
    assert(bounded.messages[1].text == "156" and bounded.messages[50].text == "205")
    now = 110
    capture(nil, "CHAT_MSG_PARTY", string.rep("x", 2000), "Leader")
    local recent = C.ReadChatHistory({ lastSeconds = 5 })
    assert(recent.count == 1 and #recent.messages[1].text == 1000)
    now = 1910
    assert(C.ReadChatHistory({}).count == 0)
    capture(nil, "CHAT_MSG_PARTY", "new", "Leader")
    C.ClearChatHistory()
    assert(C.ReadChatHistory({}).count == 0)
    assert(C.db.chatChannels.party and C.db.chatHistory == nil)
end)

it("chat settings controls change channels and clear buffered messages", function()
    local _ENV = helper.env()
    setupUI(_ENV)

    C.BuildUI()
    assert(UI_TEST.frames.WispAIChatHistorySettings)
    local whisper = UI_TEST.frames.WispAIChatChannel_whisper
    assert(whisper and not whisper:GetChecked())
    whisper:SetChecked(true)
    whisper.scripts.OnClick(whisper)
    assert(C.ChatChannelEnabled("whisper"))
    whisper:SetChecked(false)
    whisper.scripts.OnClick(whisper)
    assert(not C.ChatChannelEnabled("whisper"))
    local chatFrame
    for _, w in ipairs(UI_TEST.widgets) do
        if w.scripts.OnEvent and w ~= UI_TEST.frames.WispAIWindow then
            -- Capture is the first frame created before the UI.
            chatFrame = w
            break
        end
    end
    assert(chatFrame)
    chatFrame.scripts.OnEvent(chatFrame, "CHAT_MSG_PARTY", "hello", "Leader")
    assert(C.ReadChatHistory({}).count == 1)
    local clear
    for _, w in ipairs(UI_TEST.widgets) do
        if w.text == "Clear history" then
            clear = w
        end
    end
    assert(clear and clear.scripts.OnClick)
    clear.scripts.OnClick(clear)
    assert(C.ReadChatHistory({}).count == 0)
end)

it("public channels require individual selection and follow names when numbers change", function()
    local _ENV = helper.env()
    setupCapture(_ENV)

    C.db.chatChannels = { channel = true }
    function GetChannelList()
        return 1, "General", false, 2, "Trade", true, 3, "LookingForGroup", false
    end
    local joined = C.PublicChatChannels()
    assert(#joined == 3 and joined[2].id == 2 and joined[2].disabled)
    local function message(id, name, text)
        capture(
            nil,
            "CHAT_MSG_CHANNEL",
            text or name,
            "Player",
            nil,
            id .. ". " .. name,
            nil,
            nil,
            nil,
            id,
            name
        )
    end
    message(1, "General")
    assert(C.ReadChatHistory({}).count == 0, "legacy switch must not enable every public channel")
    C.SetPublicChatChannel("General", true)
    C.SetPublicChatChannel("LookingForGroup", true)
    message(1, "General")
    message(2, "Trade")
    message(3, "LookingForGroup")
    message(4, "NewChannel")
    local result = C.ReadChatHistory({ channels = { "channel" } })
    assert(result.count == 2 and #result.enabledPublicChannels == 2)
    assert(result.enabledPublicChannels[1].id == 1 and result.enabledPublicChannels[2].id == 3)
    assert(C.ReadChatHistory({ channelIndex = 3 }).messages[1].channelName == "LookingForGroup")
    function GetChannelList()
        return 1, "Trade", false, 2, "General", false, 3, "LookingForGroup", false
    end
    message(1, "Trade")
    -- Resolve a missing event base name using the current channel list.
    capture(
        nil,
        "CHAT_MSG_CHANNEL",
        "renumbered",
        "Player",
        nil,
        "2. General",
        nil,
        nil,
        nil,
        2,
        ""
    )
    assert(C.ReadChatHistory({ channelName = "General" }).count == 2)
    assert(C.ReadChatHistory({ channelName = "Trade" }).count == 0)
    C.SetPublicChatChannel("GENERAL", false)
    assert(C.ReadChatHistory({ channelName = "General" }).count == 0)
    C.SetPublicChatChannel("General", true)
    assert(
        C.ReadChatHistory({ channelName = "General" }).count == 0,
        "disabled history must be discarded"
    )
end)

it(
    "public channel settings refresh joined channels and preserve checkbox callbacks on reorder",
    function()
        local _ENV = helper.env()
        setupUI(_ENV)

        function GetChannelList()
            return 1, "General", false, 2, "Trade", false, 3, "LookingForGroup", false
        end
        C.BuildUI()
        local first = UI_TEST.frames.WispAIPublicChatChannel_1
        local third = UI_TEST.frames.WispAIPublicChatChannel_3
        assert(first.channelName == "General" and not first:GetChecked())
        first:SetChecked(true)
        first.scripts.OnClick(first)
        third:SetChecked(true)
        third.scripts.OnClick(third)
        assert(
            C.PublicChatChannelEnabled("General") and C.PublicChatChannelEnabled("LookingForGroup")
        )
        assert(not C.PublicChatChannelEnabled("Trade"))
        function GetChannelList()
            return 1, "Trade", false, 2, "General", false
        end
        C.RefreshChatChannelSettings()
        assert(first.channelName == "Trade" and not first:GetChecked())
        assert(not third:IsShown())
        local second = UI_TEST.frames.WispAIPublicChatChannel_2
        assert(second.channelName == "General" and second:GetChecked())
        second:SetChecked(false)
        second.scripts.OnClick(second)
        assert(not C.PublicChatChannelEnabled("General"))
        function GetChannelList() end
        C.RefreshChatChannelSettings()
        assert(not first:IsShown() and not second:IsShown())
    end
)
