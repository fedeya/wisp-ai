local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
end

it(
    "routine subscriptions debounce events, retain combat readings and stop unused listeners",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace({ connected = true, chats = {} })
            sent, tickers = {}, {}
            ns.Transport.Send = function(p)
                sent[#sent + 1] = p
            end
            ns.Character.Capture = function()
                return { character = "mage" }
            end
            C_Timer.NewTicker = function(seconds, fn)
                tickers[seconds] = fn
            end
            combat = false
            InCombatLockdown = function()
                return combat
            end
        end
        helper.addon("Advice/Advice.lua", env)

        ns.Advice.InitAdvice()
        local events
        for _, w in ipairs(UI_TEST.widgets) do
            if w.scripts.OnEvent then
                events = w
            end
        end
        assert(events)
        local registered = {}
        events.RegisterEvent = function(_, name)
            registered[name] = true
        end
        events.UnregisterEvent = function(_, name)
            registered[name] = nil
        end
        ns.Advice.ReceiveRoutineSubscriptions(
            { { native = "PLAYER_LEVEL_UP", event = "level_up" } },
            true
        )
        assert(registered.PLAYER_LEVEL_UP)
        local onEvent = events.scripts.OnEvent
        onEvent(events, "PLAYER_LEVEL_UP", 26)
        onEvent(events, "PLAYER_LEVEL_UP", 26)
        assert(#sent == 0)
        combat = true
        tickers[2]()
        assert(#sent == 1 and sent[1].data.values.level == 26 and sent[1].data.ready == false)
        combat = false
        tickers[15]()
        assert(sent[2].type == "routine_tick" and sent[2].data.ready == true)
        ns.Advice.ReceiveRoutineSubscriptions({}, false)
        assert(not registered.PLAYER_LEVEL_UP)
        tickers[2]()
        tickers[15]()
        assert(#sent == 2)
    end
)

it(
    "sidebar groups run conversations under their routine and excludes them from ordinary chats",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
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

        ns.db = { sidebar = true, showTools = true, drafts = {} }
        ns.active, ns.connected = "chat", true
        ns.chats = {
            { id = "chat", title = "Ordinary chat", status = "done", messages = {}, activity = {} },
            {
                id = "run-one",
                title = "Level 24 review",
                routineId = "mage",
                status = "done",
                messages = {},
                activity = {},
            },
        }
        ns.routines = {
            { id = "mage", title = "Mage review\nlong title", enabled = true },
            { id = "quests", title = "Quest suggestions", enabled = false },
        }
        ns.routineRuns = {
            {
                id = "run-one",
                routineId = "mage",
                event = "level_up",
                status = "done",
                startedAt = 1000000,
            },
            {
                id = "quiet",
                routineId = "mage",
                event = "level_up",
                status = "no_tip",
                startedAt = 2000000,
            },
        }
        local function run(index)
            return {
                id = "run-" .. index,
                routineId = "mage",
                event = "level_up",
                status = "done",
                startedAt = index * 10000,
            }
        end
        for index = 1, 8 do
            table.insert(ns.routineRuns, index, run(index))
        end
        ns.Transport.Send = function(packet)
            UI_TEST.sent = packet
        end
        ns.Character.Capture = function()
            return {}
        end
        ns.UI.BuildUI()
        local function row(id)
            for _, w in ipairs(UI_TEST.widgets) do
                if w.chatId == id then
                    return w
                end
            end
        end
        assert(row("chat"):IsShown())
        assert(not row("run-one"), "routine runs must not appear in Chats")
        ns.sidebarTab = "routines"
        ns.UI.Refresh()
        assert(not row("chat"):IsShown())
        local routine = row("routine-header:mage")
        local quests = row("routine-header:quests")
        assert(routine and routine:IsShown())
        assert(routine.title:GetText() == "Mage review long title" and not routine.title.wordWrap)
        routine.scripts.OnClick(routine)
        assert(ns.sidebarRoutine == "mage")
        assert(routine:IsVisible() and quests:IsVisible())
        local result = row("run-one")
        assert(result and result:IsShown())
        assert(row("run-5"):IsVisible() and not row("run-4"))
        result.scripts.OnClick(result)
        assert(ns.active == "run-one" and UI_TEST.sent.type == "select")
        local quiet = row("quiet")
        assert(not quiet, "silent runs must not appear in routine history")

        ns.routineHistory = true
        ns.UI.Refresh()
        local firstRequest = UI_TEST.sent
        assert(firstRequest.type == "routine_history" and firstRequest.key == "mage")
        assert(not firstRequest.data, "the first page starts at the newest run")
        ns.routineHistory = {
            routineId = "mage",
            requestId = firstRequest.requestId,
            runs = { ns.routineRuns[9], run(8), run(7), run(6), run(5) },
            next = "run-5",
        }
        ns.UI.Refresh()
        local loadMore
        for _, widget in ipairs(UI_TEST.widgets) do
            if widget:GetText() == "Load more" and widget:IsVisible() then
                loadMore = widget
                break
            end
        end
        assert(loadMore)
        local _, _, _, _, questsPosition = quests:GetPoint()
        loadMore.scripts.OnClick()
        local secondRequest = UI_TEST.sent
        assert(secondRequest.type == "routine_history" and secondRequest.data.before == "run-5")
        ns.routineHistory = {
            routineId = "mage",
            requestId = secondRequest.requestId,
            runs = { run(4), run(3), run(2), run(1), run(0) },
        }
        ns.UI.Refresh()
        assert(row("run-4"):IsVisible() and row("run-0"):IsVisible() and not loadMore:IsShown())
        local _, _, _, _, lastPosition = quests:GetPoint()
        assert(
            lastPosition >= questsPosition,
            "additional runs must not push the next routine down"
        )
        local oldest = row("run-0")
        oldest.scripts.OnClick(oldest)
        assert(ns.active == "run-0" and ns.sidebarRoutine == "mage")
        quests.scripts.OnClick(quests)
        assert(ns.sidebarRoutine == "quests" and routine:IsVisible() and quests:IsVisible())
        assert(not oldest:IsVisible() or oldest.chatId ~= "run-0")
    end
)
