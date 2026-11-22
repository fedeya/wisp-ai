local helper = require("addon.tests.support")

-- Builds the window with a controllable timer queue and quest log, and counts
-- redraws caused by the item, macro and quest events.
local function scenario(references)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    local timers = {}
    C_Timer = {
        After = function(delay, fn)
            timers[#timers + 1] = { delay = delay, fn = fn }
        end,
    }
    local quest = { title = "Quest A", level = 10 }
    C_QuestLog = {
        GetNumQuestLogEntries = function()
            return 1
        end,
        GetInfo = function()
            return { isHeader = false, questID = 42, title = quest.title, level = quest.level }
        end,
    }
    local writes = 0
    local stored = {}
    local questReferences = setmetatable({}, {
        __index = stored,
        __newindex = function(_, key, value)
            writes = writes + 1
            stored[key] = value
        end,
    })
    ns = helper.namespace({
        db = { sidebar = true, showTools = true, drafts = {}, questReferences = questReferences },
        active = "chat",
        connected = true,
    })
    local reply = {
        id = "m1",
        role = "assistant",
        text = "[[ref:robe]]",
        references = references or { robe = { kind = "item", id = 100, label = "Robe" } },
    }
    ns.chats = { { id = "chat", title = "Events", status = "done", messages = { reply } } }
    function ns.Chat.Current()
        return ns.chats[1]
    end
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()

    local events
    for _, widget in ipairs(UI_TEST.widgets) do
        if not widget.name and widget.scripts.OnEvent then
            assert(not events, "expected one item and quest event frame")
            events = widget
        end
    end
    assert(events, "the window must listen for item and quest events")

    local state = { redraws = 0, quest = quest, ns = ns, reply = reply }
    function ns.UI.Refresh()
        state.redraws = state.redraws + 1
    end
    for index = #timers, 1, -1 do
        timers[index] = nil
    end
    writes = 0

    function state.fire(event, ...)
        events.scripts.OnEvent(events, event, ...)
    end
    function state.timers()
        return #timers
    end
    function state.delays()
        local delays = {}
        for _, timer in ipairs(timers) do
            delays[#delays + 1] = timer.delay
        end
        table.sort(delays)
        return delays
    end
    function state.flush()
        local due = timers
        timers = {}
        for _, timer in ipairs(due) do
            timer.fn()
        end
    end
    function state.writes()
        return writes
    end
    function state.signature()
        return ns.UI.MessageFormat.Signature(reply.references)
    end
    return state
end

describe("item, macro and quest events", function()
    it("redraw a burst that loads a shown item once, after one timer", function()
        local s = scenario()
        local before = s.signature()
        for id = 51, 100 do
            s.fire("GET_ITEM_INFO_RECEIVED", id, true)
        end
        assert.same({ 0.2 }, s.delays())
        assert.equal(0, s.redraws)
        s.flush()
        assert.equal(1, s.redraws)
        assert.are_not.equal(before, s.signature(), "the reply showing the item must render again")
        s.fire("GET_ITEM_INFO_RECEIVED", 100, true)
        assert.equal(1, s.timers(), "a later burst arms a new timer")
    end)

    it("do not redraw for items no chat on screen shows", function()
        local s = scenario()
        local before = s.signature()
        for id = 1, 50 do
            s.fire("GET_ITEM_INFO_RECEIVED", id, true)
        end
        s.fire("GET_ITEM_INFO_RECEIVED", nil, false)
        assert.equal(1, s.timers())
        s.flush()
        assert.equal(0, s.redraws)
        assert.equal(before, s.signature(), "unrelated items must not render the reply again")
    end)

    it("redraw macro changes only for chats that show a macro", function()
        local s = scenario()
        s.fire("UPDATE_MACROS")
        s.flush()
        assert.equal(0, s.redraws)

        s = scenario({ heal = { kind = "macro", name = "Heal", label = "Heal" } })
        s.fire("UPDATE_MACROS")
        s.fire("UPDATE_MACROS")
        assert.equal(1, s.timers())
        s.flush()
        assert.equal(1, s.redraws)
    end)

    it(
        "leave a minimized window to redraw when restored, but redraw an open inline chat",
        function()
            local s = scenario()
            s.ns.db.minimized = true
            local inlineRedraws = 0
            s.ns.Inline.RefreshInline = function()
                inlineRedraws = inlineRedraws + 1
            end
            s.ns.Inline.InlineCurrent = function()
                return nil
            end
            s.fire("GET_ITEM_INFO_RECEIVED", 100, true)
            s.flush()
            assert.equal(0, s.redraws)
            assert.equal(0, inlineRedraws)

            s.ns.Inline.InlineCurrent = function()
                return { id = "inline", messages = { s.reply } }
            end
            s.fire("GET_ITEM_INFO_RECEIVED", 100, true)
            s.flush()
            assert.equal(0, s.redraws)
            assert.equal(1, inlineRedraws)
        end
    )

    it("store changed quests without redrawing, and leave unchanged quests alone", function()
        local s = scenario()
        for _ = 1, 10 do
            s.fire("QUEST_LOG_UPDATE")
        end
        assert.same({ 0.4 }, s.delays())
        s.flush()
        assert.equal(0, s.writes(), "BuildUI already stored the quest")

        s.quest.level = 11
        for _ = 1, 10 do
            s.fire("QUEST_LOG_UPDATE")
        end
        assert.equal(1, s.timers())
        s.flush()
        assert.equal(1, s.writes())
        assert.equal(11, s.ns.UI.MessageFormat.Quest(42).level)
        assert.equal(0, s.redraws, "quest links read the stored quest when hovered")
    end)

    it("batch item and quest events on separate timers", function()
        local s = scenario()
        s.fire("GET_ITEM_INFO_RECEIVED", 100, true)
        s.fire("QUEST_LOG_UPDATE")
        s.fire("UPDATE_MACROS")
        s.fire("QUEST_LOG_UPDATE")
        assert.same({ 0.2, 0.4 }, s.delays())
        s.flush()
        assert.equal(1, s.redraws)
    end)
end)
