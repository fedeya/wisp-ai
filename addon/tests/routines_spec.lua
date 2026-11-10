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
        ns.routines = { { id = "mage", title = "Mage review", enabled = true } }
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
        assert(routine and routine:IsShown())
        routine.scripts.OnClick(routine)
        assert(ns.sidebarRoutine == "mage")
        local result = row("run-one")
        assert(result and result:IsShown())
        result.scripts.OnClick(result)
        assert(ns.active == "run-one" and UI_TEST.sent.type == "select")
        local quiet = row("quiet")
        assert(not quiet, "silent runs must not appear in routine history")
    end
)
