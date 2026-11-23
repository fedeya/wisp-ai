local helper = require("addon.tests.support")

-- Opens the window on a long reply, scrolled up, and returns the jump button.
local function scenario(tools)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    ns = helper.namespace({
        db = { sidebar = true, showTools = true, drafts = {} },
        active = "chat",
        connected = true,
    })
    local chat = {
        id = "chat",
        title = "Reading",
        status = "done",
        messages = {
            {
                id = "long",
                role = "assistant",
                text = string.rep("Long reply about [[ref:robe]] ", 1000),
                references = { robe = { kind = "item", id = 100, label = "Robe" } },
            },
        },
    }
    for _, tool in
        ipairs(tools or {
            {
                id = "tool",
                role = "tool",
                text = "Searching",
                tool = { name = "search", status = "running" },
            },
        })
    do
        chat.messages[#chat.messages + 1] = tool
    end
    ns.chats = { chat }
    function ns.Chat.Current()
        return chat
    end
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    local jump
    for _, widget in ipairs(UI_TEST.widgets) do
        if widget:GetText() == "New messages v" then
            jump = widget
        end
    end
    UI_TEST.frames.WispAITranscriptScrollBar:SetValue(0)
    ns.UI.Refresh()
    assert(not jump:IsShown(), "scrolling up alone is not a new message")
    return {
        chat = chat,
        ns = ns,
        jump = jump,
        widgets = UI_TEST.widgets,
        transcript = UI_TEST.frames.WispAIProgress.parent.parent,
    }
end

describe("the new messages button", function()
    it("appears for a new message while reading earlier ones", function()
        local s = scenario()
        s.chat.messages[#s.chat.messages + 1] = { id = "next", role = "user", text = "Next" }
        s.ns.UI.Refresh()
        assert.is_true(s.jump:IsShown())
    end)

    it("appears when a shown tool call finishes", function()
        local s = scenario()
        s.chat.messages[2].tool = { name = "search", status = "done", resultPreview = "Found it" }
        s.ns.UI.Refresh()
        assert.is_true(s.jump:IsShown())
    end)

    it("ignores expanding and collapsing tool calls", function()
        local s = scenario({
            {
                id = "a",
                role = "tool",
                text = "Searching",
                tool = { name = "search", status = "completed" },
            },
            {
                id = "b",
                role = "tool",
                text = "Reading",
                tool = { name = "read", status = "completed" },
            },
        })
        local disclosure
        for _, widget in ipairs(s.widgets) do
            if widget.parent and widget.parent.disclosure == widget and widget:IsShown() then
                disclosure = widget
            end
        end
        assert(disclosure, "the tool group can be expanded")
        disclosure.scripts.OnClick(disclosure)
        assert.is_false(s.jump:IsShown(), "expanding tools is not new content")
        disclosure.scripts.OnClick(disclosure)
        assert.is_false(s.jump:IsShown(), "collapsing tools is not new content")
    end)

    it("ignores a redraw that only resolves a link or changes the width", function()
        local s = scenario()
        s.ns.UI.MessageFormat.MarkItemLoaded(100)
        s.ns.UI.Refresh()
        assert.is_false(s.jump:IsShown(), "item data loading is not new content")
        local width = s.transcript:GetWidth()
        s.transcript:SetWidth(width - 100)
        s.ns.UI.Refresh()
        assert.are_not.equal(width, s.transcript:GetWidth())
        assert.is_false(s.jump:IsShown(), "a narrower window is not new content")
    end)
end)

describe("a reply view", function()
    local function view()
        local env = helper.env()
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        env.ns = helper.namespace()
        helper.addon("UI/Window.lua", env)
        return env.ns
    end

    it("counts changes to what a reply says, not to how its links resolve", function()
        local ns = view()
        local state = ns.Markdown.ReplyView.New()
        local message = {
            id = "reply",
            role = "assistant",
            text = "Wear [[ref:robe]]",
            references = { robe = { kind = "item", id = 100, label = "Robe" } },
        }
        local _, firstKey = ns.Markdown.ReplyView.Update(state, "chat", message)
        local said = state.said
        local _, sameKey = ns.Markdown.ReplyView.Update(state, "chat", message)
        assert.equal(firstKey, sameKey)
        assert.equal(said, state.said)

        ns.UI.MessageFormat.MarkItemLoaded(100)
        local _, loadedKey = ns.Markdown.ReplyView.Update(state, "chat", message)
        assert.are_not.equal(sameKey, loadedKey, "a loaded item still renders the reply again")
        assert.equal(said, state.said)

        message.text = message.text .. " now"
        local _, textKey = ns.Markdown.ReplyView.Update(state, "chat", message)
        assert.are_not.equal(loadedKey, textKey)
        assert.equal(said + 1, state.said)

        message.ui = { { id = "action", kind = "button", label = "Equip" } }
        ns.Markdown.ReplyView.Update(state, "chat", message)
        assert.equal(said + 2, state.said)
    end)
end)
