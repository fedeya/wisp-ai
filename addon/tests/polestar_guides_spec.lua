local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace({ db = {} })
        clock = 1000
        function time()
            return clock
        end
    end
    helper.addon("Integrations/PolestarGuides.lua", env)
end

-- A Polestar double following docs/API.md: the planner builds, BuildGuide
-- returns lookup/<kind>/<id>, RegisterGuide keeps the table, SetGuide opens it.
local function fakePolestar(options)
    options = options or {}
    local p = { planners = {}, guides = {}, opened = {}, replaced = {} }
    p.API = {
        version = options.version or 1,
        ReplaceSteps = function(id, steps)
            if not p.guides[id] then
                return false, "unknown guide"
            end
            p.replaced[#p.replaced + 1] = { id = id, steps = steps }
            return true
        end,
    }
    p.Lookup = {
        RegisterPlanner = function(kind, build)
            p.planners[kind] = build
        end,
        BuildGuide = function(kind, id)
            local guide, reason = p.planners[kind](id)
            if not guide then
                return nil, reason
            end
            guide.id = "lookup/" .. kind .. "/" .. id
            guide.pack = "lookup"
            return guide
        end,
    }
    p.RegisterGuide = function(guide)
        if options.refuse then
            return false, options.refuse
        end
        p.guides[guide.id] = guide
        return true
    end
    p.Engine = {
        SetGuide = function(id)
            p.opened[#p.opened + 1] = id
            return p.guides[id] ~= nil
        end,
    }
    return p
end

local function chain()
    return {
        title = "Thwarting Kolkar",
        steps = {
            {
                title = "Razor Hill",
                goals = {
                    {
                        type = "accept",
                        questId = 786,
                        questTitle = "Thwarting Kolkar Aggression",
                        npcId = 3139,
                        npcName = "Gar'Thok",
                        mapId = 1411,
                        x = 51.9,
                        y = 43.5,
                    },
                },
            },
            {
                note = "Burn the three banners.",
                goals = {
                    {
                        type = "interact",
                        objectId = 3190,
                        objectName = "Attack Plan: Valley of Trials",
                        questId = 786,
                        objective = 1,
                    },
                    { type = "kill", target = "Kolkar Drudge", count = 8, optional = false },
                    { type = "note", text = "Watch for patrols." },
                },
            },
        },
    }
end

it("builds a Polestar guide with Polestar's goal fields and opens it", function()
    local env = helper.env()
    setup(env)
    local p = fakePolestar()
    env.Polestar = p
    local result = env.ns.Integrations.CreatePolestarGuide(chain())
    assert.equals("g1000", result.id)
    assert.equals("lookup/wisp/g1000", result.guideId)
    assert.equals(2, result.steps)
    assert.equals(4, result.goals)
    assert.is_false(result.updated)
    assert.is_true(result.opened)
    assert.same({ "lookup/wisp/g1000" }, p.opened)
    local guide = p.guides["lookup/wisp/g1000"]
    assert.equals("Thwarting Kolkar", guide.title)
    assert.equals("Wisp", guide.author)
    assert.same({
        t = "accept",
        quest = 786,
        title = "Thwarting Kolkar Aggression",
        npc = 3139,
        npcName = "Gar'Thok",
        map = 1411,
        x = 51.9,
        y = 43.5,
    }, guide.steps[1].goals[1])
    assert.same({
        t = "interact",
        object = 3190,
        objName = "Attack Plan: Valley of Trials",
        quest = 786,
        oi = 1,
    }, guide.steps[2].goals[1])
    assert.same({ t = "kill", target = "Kolkar Drudge", count = 8 }, guide.steps[2].goals[2])
    assert.equals("Burn the three banners.", guide.steps[2].note)
    assert.equals("g1000", env.ns.db.polestarGuides[1].id)
end)

it("updates an earlier guide in place with ReplaceSteps", function()
    local env = helper.env()
    setup(env)
    local p = fakePolestar()
    env.Polestar = p
    local first = env.ns.Integrations.CreatePolestarGuide(chain())
    local next = chain()
    next.id = first.id
    next.open = false
    table.remove(next.steps, 1)
    local result = env.ns.Integrations.CreatePolestarGuide(next)
    assert.is_true(result.updated)
    assert.is_false(result.opened)
    assert.equals(1, #p.opened)
    assert.equals(1, #p.replaced)
    assert.equals("lookup/wisp/" .. first.id, p.replaced[1].id)
    assert.equals("interact", p.replaced[1].steps[1].goals[1].t)
    assert.equals(1, #env.ns.db.polestarGuides)
end)

it("keeps the planner's earlier guide when Polestar refuses a new one", function()
    local env = helper.env()
    setup(env)
    env.Polestar = fakePolestar({ refuse = "step 1 has no goals" })
    local ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, chain())
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("Polestar refused the guide: step 1 has no goals", 1, true))
    assert.is_nil(env.ns.db.polestarGuides)
end)

it("rejects goals missing what Polestar requires and bad ids", function()
    local env = helper.env()
    setup(env)
    env.Polestar = fakePolestar()
    local bad = chain()
    bad.steps[2].goals[1].objectName = nil
    local ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, bad)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("Step 2 goal 1 (interact) needs objectName", 1, true))
    bad = chain()
    bad.steps[1].goals[1].type = "teleport"
    ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, bad)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("unsupported type teleport", 1, true))
    bad = chain()
    bad.id = "../Bad"
    ok = pcall(env.ns.Integrations.CreatePolestarGuide, bad)
    assert.is_false(ok)
    bad = chain()
    bad.steps[1].goals = {}
    ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, bad)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("Step 1 has no goals", 1, true))
end)

it("requires Polestar's guide API version 1", function()
    local env = helper.env()
    setup(env)
    assert.is_false(env.ns.Integrations._PolestarGuidesReady())
    env.Polestar = fakePolestar({ version = 2 })
    assert.is_false(env.ns.Integrations._PolestarGuidesReady())
    local ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, chain())
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("guide API version is not supported", 1, true))
    env.Polestar = fakePolestar()
    assert.is_true(env.ns.Integrations._PolestarGuidesReady())
end)

it("saves the latest five guides and registers them again after a reload", function()
    local env = helper.env()
    setup(env)
    env.Polestar = fakePolestar()
    for i = 1, 7 do
        env.clock = 1000 + i
        env.ns.Integrations.CreatePolestarGuide(chain())
    end
    local saved = env.ns.db.polestarGuides
    assert.equals(5, #saved)
    assert.equals("g1007", saved[1].id)
    assert.equals("g1003", saved[5].id)

    -- A reload: a fresh addon namespace and Polestar, the same saved variables.
    local reloaded = helper.env()
    setup(reloaded)
    reloaded.ns.db = env.ns.db
    table.insert(reloaded.ns.db.polestarGuides, { id = "Bad Id", title = "x", steps = {} })
    local p = fakePolestar()
    reloaded.Polestar = p
    assert.equals(5, reloaded.ns.Integrations.RestorePolestarGuides())
    assert.equals(5, #reloaded.ns.db.polestarGuides)
    assert.is_truthy(p.guides["lookup/wisp/g1007"])
    assert.same({}, p.opened)
    local update = chain()
    update.id = "g1007"
    assert.is_true(reloaded.ns.Integrations.CreatePolestarGuide(update).updated)
end)

it("restores nothing without Polestar", function()
    local env = helper.env()
    setup(env)
    env.ns.db.polestarGuides = { { id = "g1", title = "x", steps = chain().steps } }
    assert.equals(0, env.ns.Integrations.RestorePolestarGuides())
    assert.equals(1, #env.ns.db.polestarGuides)
end)

it("puts the earlier guide back when Polestar cannot update the open one", function()
    local env = helper.env()
    setup(env)
    local p = fakePolestar()
    env.Polestar = p
    local first = env.ns.Integrations.CreatePolestarGuide(chain())
    p.API.ReplaceSteps = function()
        return false, "busy"
    end
    local next = chain()
    next.id = first.id
    next.title = "Renamed"
    local ok, err = pcall(env.ns.Integrations.CreatePolestarGuide, next)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("could not update the open guide: busy", 1, true))
    assert.equals("Thwarting Kolkar", p.guides[first.guideId].title)
    assert.equals("Thwarting Kolkar", env.ns.db.polestarGuides[1].title)
end)

it("reports each saved guide it could not restore", function()
    local env = helper.env()
    setup(env)
    env.ns.db.polestarGuides = {
        { id = "g1", title = "Kept", steps = chain().steps },
        { id = "Bad Id", title = "x", steps = {} },
    }
    env.Polestar = fakePolestar()
    local restored, failures = env.ns.Integrations.RestorePolestarGuides()
    assert.equals(1, restored)
    assert.same({ "Bad Id: invalid saved guide" }, failures)
end)
