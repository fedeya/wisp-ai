local helper = require("addon.tests.support")

-- Opens the window on a chat of `count` alternating questions and replies.
local function scenario(count)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    ns = helper.namespace({
        db = { sidebar = true, showTools = true, drafts = {} },
        active = "chat",
        connected = true,
    })
    local messages = {}
    for index = 1, count do
        messages[index] = {
            id = "m" .. index,
            role = index % 2 == 1 and "user" or "assistant",
            phase = index % 2 == 0 and "reply" or nil,
            text = "Message " .. index,
        }
    end
    local chat = { id = "chat", title = "Window", status = "done", messages = messages }
    ns.chats = { chat }
    function ns.Chat.Current()
        return chat
    end
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()

    local s = { chat = chat, ns = ns, bar = UI_TEST.frames.WispAITranscriptScrollBar }
    -- Message IDs of the transcript rows on screen, oldest first.
    function s.rendered()
        local shown = {}
        for _, widget in ipairs(UI_TEST.widgets) do
            local view = rawget(widget, "replyView")
            if view and widget:IsShown() and widget.chatId == "chat" then
                shown[#shown + 1] = { id = view.messageId, y = widget.y }
            end
        end
        table.sort(shown, function(a, b)
            return a.y < b.y
        end)
        local ids = {}
        for index, row in ipairs(shown) do
            ids[index] = row.id
        end
        return ids
    end
    function s.rowAt(id)
        for _, widget in ipairs(UI_TEST.widgets) do
            local view = rawget(widget, "replyView")
            if view and widget:IsShown() and view.messageId == id then
                return widget
            end
        end
    end
    return s
end

describe("the transcript window", function()
    it("renders every message of a short chat", function()
        local s = scenario(30)
        local ids = s.rendered()
        assert.equal(30, #ids)
        assert.equal("m1", ids[1])
    end)

    it("renders only the latest messages of a long chat, at the bottom", function()
        local s = scenario(120)
        local ids = s.rendered()
        assert.equal(50, #ids)
        assert.equal("m71", ids[1])
        assert.equal("m120", ids[50])
        assert.equal(s.bar.max, s.bar:GetValue(), "a long chat opens at its latest message")
    end)

    it("renders earlier messages at the top and keeps the view on the same message", function()
        local s = scenario(120)
        s.bar:SetValue(0)
        local ids = s.rendered()
        assert.equal(100, #ids)
        assert.equal("m21", ids[1])
        local previousTop = s.rowAt("m71")
        assert.equal(previousTop.y, s.bar:GetValue(), "the old first message stays at the top")

        s.bar:SetValue(0)
        ids = s.rendered()
        assert.equal(120, #ids)
        assert.equal("m1", ids[1])
        s.bar:SetValue(0)
        assert.equal(120, #s.rendered(), "nothing earlier is left to render")
    end)

    it("renders earlier messages when the wheel turns up at the top", function()
        local s = scenario(120)
        for _ = 1, 400 do
            s.ns.UI.ScrollTranscript(1)
            if #s.rendered() > 50 then
                break
            end
        end
        assert.equal(100, #s.rendered())
        assert.is_true(s.bar:GetValue() > 0, "the wheel lands on the old first message")
    end)

    it("keeps earlier messages while reading and drops them when following new ones", function()
        local s = scenario(120)
        s.bar:SetValue(0)
        assert.equal(100, #s.rendered())
        local function append(count)
            for _ = 1, count do
                local index = #s.chat.messages + 1
                s.chat.messages[index] = { id = "m" .. index, role = "user", text = "More" }
            end
            s.ns.UI.Refresh()
        end
        append(10)
        assert.equal(110, #s.rendered(), "reading earlier messages keeps them rendered")
        assert.equal("m21", s.rendered()[1])

        s.bar:SetValue(s.bar.max)
        append(1)
        local ids = s.rendered()
        assert.equal(50, #ids, "following the bottom goes back to the latest messages")
        assert.equal("m131", ids[50])
    end)

    it("remembers each chat's earlier messages when switching back", function()
        local s = scenario(120)
        s.bar:SetValue(0)
        local other = {
            id = "other",
            status = "done",
            messages = { { id = "o1", role = "user", text = "Hi" } },
        }
        s.ns.chats[2] = other
        local current = s.chat
        function s.ns.Chat.Current()
            return current
        end
        current = other
        s.ns.UI.Refresh()
        current = s.chat
        s.ns.UI.Refresh()
        assert.equal(100, #s.rendered())
        assert.equal("m21", s.rendered()[1])
    end)
end)
