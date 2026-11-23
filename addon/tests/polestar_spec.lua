local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
    end
    helper.addon("Integrations/Integrations.lua", env)
    helper.addon("Integrations/PolestarGuides.lua", env)
    helper.addon("Integrations/Polestar.lua", env)
end

local function views()
    return {
        [4] = {
            title = "|cffffd100Razor Hill|r",
            note = "Grab the |Hquest:786|h[Thwarting Kolkar Aggression]|h flag first.",
            status = "current",
            section = { title = "Durotar 10-12" },
            goals = {
                {
                    t = "goto",
                    text = "Razor Hill",
                    status = "done",
                    header = true,
                },
                {
                    t = "kill",
                    text = "|TInterface\\Icons\\x:0|t Kill Kolkar Drudge",
                    status = "active",
                    progress = { cur = 3, max = 8, label = "Kolkar Drudge" },
                    quest = 786,
                    npc = 3119,
                    npcName = "Kolkar Drudge",
                },
                { t = "collect", text = "Hidden row", status = "active", folded = true },
                {
                    t = "turnin",
                    text = "Turn in Thwarting Kolkar Aggression",
                    status = "pending",
                    optional = true,
                    quest = 786,
                },
            },
        },
        [5] = {
            title = "Sen'jin Village",
            status = "next",
            goals = { { t = "goto", text = "Go" } },
        },
        [6] = { title = "Echo Isles", status = "next", goals = {} },
    }
end

local function polestar(overrides)
    local steps = views()
    local engine = {
        GetGuide = function()
            return {
                id = "leveling/orc/1-12",
                title = "Orc 1-12",
                category = "Leveling",
                pack = "orc",
            }
        end,
        GetStepIndex = function()
            return 4
        end,
        GetStepCount = function()
            return 6
        end,
        StepTotal = function()
            return 5
        end,
        StepNumber = function(i)
            return i - 1, false
        end,
        GetStepView = function(i)
            return steps[i]
        end,
        GetProgress = function()
            return 3, 6
        end,
        GetLiveStep = function()
            return 4
        end,
    }
    for key, value in pairs(overrides or {}) do
        engine[key] = value
    end
    return { API = { version = 1 }, Engine = engine }
end

it("Polestar discovery distinguishes missing, incompatible, partial and ready APIs", function()
    local env = helper.env()
    setup(env)
    local report = env.ns.Integrations._PolestarReport
    assert.same({ status = "missing", guides = false }, report())
    env.Polestar = {}
    assert.same({ status = "incompatible", version = "unknown", guides = false }, report())
    env.Polestar = polestar()
    env.Polestar.API.version = 2
    assert.equals("incompatible", report().status)
    env.Polestar = polestar({ GetStepView = false })
    assert.equals("partial", report().status)
    env.Polestar = polestar()
    assert.equals("ready", report().status)
    env.Polestar.Engine.GetStepIndex = nil
    assert.equals("incompatible", report().status)
end)

it("reports the open guide, the shown step's goals in plain text and the next steps", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local result = env.ns.Integrations.InspectIntegration({ kind = "polestar_guide", args = {} })
    assert.equals("available", result.status)
    local data = result.data
    assert.same(
        { id = "leveling/orc/1-12", title = "Orc 1-12", category = "Leveling", pack = "orc" },
        data.guide
    )
    assert.equals(5, data.stepCount)
    assert.same({ done = 3, total = 6 }, data.progress)
    assert.is_nil(data.liveStepIndex)
    local step = data.step
    assert.equals(4, step.index)
    assert.equals(3, step.number)
    assert.equals("Razor Hill", step.title)
    assert.equals("Grab the [Thwarting Kolkar Aggression] flag first.", step.note)
    assert.equals("Durotar 10-12", step.section)
    assert.equals("current", step.status)
    assert.same({
        {
            text = "Kill Kolkar Drudge",
            type = "kill",
            status = "active",
            progress = { current = 3, required = 8 },
            questId = 786,
            npcId = 3119,
            npcName = "Kolkar Drudge",
        },
        {
            text = "Turn in Thwarting Kolkar Aggression",
            type = "turnin",
            status = "pending",
            optional = true,
            questId = 786,
        },
    }, step.goals)
    assert.equals(2, #data.upcoming)
    assert.equals("Sen'jin Village", data.upcoming[1].title)
    assert.equals(6, data.upcoming[2].index)
end)

it("bounds upcoming steps by the guide length and the requested count", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local read = env.ns.Integrations.ReadPolestarGuide
    assert.same({}, read({ upcoming = 0 }).upcoming)
    assert.equals(2, #read({ upcoming = 5 }).upcoming)
end)

it("reports no guide, a finished guide and a browsed step distinctly", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar({
        GetGuide = function()
            return nil
        end,
    })
    local data = env.ns.Integrations.ReadPolestarGuide({})
    assert.is_nil(data.guide)
    assert.is_nil(data.step)
    assert.is_truthy(data.note:find("No Polestar guide", 1, true))

    env.Polestar = polestar({
        GetStepIndex = function()
            return nil
        end,
    })
    data = env.ns.Integrations.ReadPolestarGuide({})
    assert.is_true(data.finished)
    assert.is_nil(data.step)

    env.Polestar = polestar({
        GetLiveStep = function()
            return 6
        end,
    })
    data = env.ns.Integrations.ReadPolestarGuide({})
    assert.equals(6, data.liveStepIndex)
    assert.equals(5, data.liveStepNumber)
end)

it("degrades to step numbers when Polestar's step reader fails", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar({
        GetStepView = function()
            error("internal change")
        end,
        GetProgress = function()
            error("internal change")
        end,
    })
    local data = env.ns.Integrations.ReadPolestarGuide({ upcoming = 1 })
    assert.same({ index = 4, number = 3 }, data.step)
    assert.same({ { index = 5, number = 4 } }, data.upcoming)
    assert.is_nil(data.progress)
end)

it("returns an unavailable inspection when Polestar is missing or unsupported", function()
    local env = helper.env()
    setup(env)
    local result = env.ns.Integrations.InspectIntegration({ kind = "polestar_guide" })
    assert.equals("unavailable", result.status)
    assert.is_truthy(result.error:find("Polestar is not loaded", 1, true))
    env.Polestar = polestar()
    env.Polestar.API.version = 2
    assert.equals(
        "unavailable",
        env.ns.Integrations.InspectIntegration({ kind = "polestar_guide" }).status
    )
end)
