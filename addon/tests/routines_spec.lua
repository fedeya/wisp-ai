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

it("the Routines page lists routines and their runs, apart from ordinary chats", function()
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
        { id = "mage", title = "Mage review", enabled = true, trigger = "On level up" },
        { id = "bags", title = "Bag check", enabled = true },
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
    assert(not row("run-one"), "routine runs must not appear in Recents")
    local page = UI_TEST.frames.WispAIRoutinesPage
    assert(not page:IsShown())
    ns.UI.Routines.Show()
    assert(page:IsShown() and ns.sidebarTab == "routines")
    assert(row("chat"):IsShown(), "Recents stay in the sidebar while Routines is open")
    local function card(id)
        for _, w in ipairs(UI_TEST.widgets) do
            if w.routine and w.routine.id == id and w.toggle then
                return w
            end
        end
    end
    local mage, bags = card("mage"), card("bags")
    assert(mage and mage:IsShown() and mage.toggle:GetChecked())
    assert(mage.detail:GetText():find("On level up", 1, true))
    assert(bags.detail:GetText():find("Runs on game events", 1, true))
    mage.toggle:SetChecked(false)
    mage.toggle.scripts.OnClick(mage.toggle)
    assert(
        UI_TEST.sent.type == "routine_action"
            and UI_TEST.sent.data.operation == "pause"
            and UI_TEST.sent.data.id == "mage"
    )
    local result = row("run-one")
    assert(result and result:IsShown())
    assert(not row("quiet"), "silent runs must not appear in routine history")
    bags.scripts.OnClick(bags)
    assert(not result:IsShown(), "selecting a routine filters its runs")
    mage.scripts.OnClick(mage)
    assert(result:IsShown())
    result.scripts.OnClick(result)
    assert(ns.active == "run-one" and UI_TEST.sent.type == "select")
    assert(not page:IsShown(), "opening a run shows its conversation")
    assert(ns.sidebarTab == "routines", "a run conversation keeps Routines selected")
    local crumb = UI_TEST.frames.WispAIRoutinesCrumb
    assert(crumb:IsShown(), "the header shows Routines in a run's breadcrumb")
    crumb.scripts.OnClick(crumb)
    assert(page:IsShown() and not crumb:IsShown(), "the breadcrumb leads back to Routines")
end)
