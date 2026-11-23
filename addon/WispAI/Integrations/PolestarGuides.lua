-- Wisp-built guides played in Polestar's guide window.
--
-- Uses only Polestar's documented API v1 (docs/API.md): a "wisp" Lookup
-- planner builds each guide, RegisterGuide adds it, Engine.SetGuide opens it
-- and API.ReplaceSteps updates a guide already registered in place, keeping
-- the player's ticks and skips. Guide ids are lookup/wisp/<id>. The latest
-- guides are saved in WispAIDB and registered again when Wisp loads, so a
-- /reload keeps the guide Polestar has open.
local _, ns = ...

local API_VERSION = 1
local KIND = "wisp"
local MAX_SAVED = 5
local ID_PATTERN = "^[a-z0-9][a-z0-9%-]*$"
local MAX_ID_BYTES = 32

-- Wire field -> Polestar goal field.
local FIELDS = {
    text = "text",
    note = "note",
    optional = "optional",
    questId = "quest",
    questTitle = "title",
    objective = "oi",
    npcId = "npc",
    npcName = "npcName",
    objectId = "object",
    objectName = "objName",
    itemId = "item",
    itemName = "itemName",
    count = "count",
    target = "target",
    location = "location",
    level = "level",
    mapId = "map",
    x = "x",
    y = "y",
}

-- The wire fields each goal type needs, as Polestar's goal table requires them.
local REQUIRED = {
    accept = { "questId", "questTitle" },
    turnin = { "questId", "questTitle" },
    complete = { "questId", "questTitle" },
    kill = { "target" },
    collect = { "itemId", "itemName" },
    ["goto"] = { "mapId", "x", "y" },
    talk = { "npcId", "npcName" },
    interact = { "objectId", "objectName" },
    use = { "itemId", "itemName" },
    buy = { "itemId", "itemName" },
    vendor = {},
    train = {},
    getfp = { "location" },
    fly = { "location" },
    hearth = { "location" },
    sethome = { "location" },
    level = { "level" },
    note = { "text" },
}

local plans = {}
local plannerRegistered = false

local function api()
    local polestar = type(Polestar) == "table" and Polestar or nil
    local public = polestar and type(polestar.API) == "table" and polestar.API or nil
    local lookup = polestar and type(polestar.Lookup) == "table" and polestar.Lookup or nil
    local engine = polestar and type(polestar.Engine) == "table" and polestar.Engine or nil
    if
        public
        and public.version == API_VERSION
        and lookup
        and type(lookup.RegisterPlanner) == "function"
        and type(lookup.BuildGuide) == "function"
        and type(polestar.RegisterGuide) == "function"
        and engine
        and type(engine.SetGuide) == "function"
    then
        return polestar, public, lookup, engine
    end
    return nil
end

function ns.Integrations._PolestarGuidesReady()
    return api() ~= nil
end

-- A new Polestar goal table from one wire goal; errors name the step and goal.
local function goalOf(goal, where)
    assert(type(goal) == "table", where .. " is not a goal")
    local required = REQUIRED[goal.type]
    assert(required, where .. " has an unsupported type " .. tostring(goal.type))
    for _, field in ipairs(required) do
        assert(goal[field] ~= nil, where .. " (" .. goal.type .. ") needs " .. field)
    end
    local out = { t = goal.type }
    for wire, field in pairs(FIELDS) do
        if goal[wire] ~= nil then
            out[field] = goal[wire]
        end
    end
    if out.optional ~= true then
        out.optional = nil
    end
    return out
end

-- New step tables every call: Polestar keeps and escapes what it is given.
local function stepsOf(steps)
    assert(type(steps) == "table" and #steps > 0, "A guide needs at least one step")
    local out = {}
    for s, step in ipairs(steps) do
        assert(type(step) == "table", "Step " .. s .. " is not a step")
        local goals = {}
        for g, goal in ipairs(type(step.goals) == "table" and step.goals or {}) do
            goals[g] = goalOf(goal, "Step " .. s .. " goal " .. g)
        end
        assert(#goals > 0, "Step " .. s .. " has no goals")
        out[s] = { title = step.title, note = step.note, goals = goals }
    end
    return out
end

local function build(id)
    local plan = plans[id]
    if not plan then
        return nil, "unknown"
    end
    local ok, steps = pcall(stepsOf, plan.steps)
    if not ok then
        return nil, tostring(steps)
    end
    return { title = plan.title, author = "Wisp", steps = steps }
end

local function ensurePlanner(lookup)
    if not plannerRegistered then
        lookup.RegisterPlanner(KIND, build)
        plannerRegistered = true
    end
end

local function register(polestar, lookup, id)
    ensurePlanner(lookup)
    local guide, reason = lookup.BuildGuide(KIND, id)
    assert(guide, "Polestar could not build the guide: " .. tostring(reason))
    local ok, refused = polestar.RegisterGuide(guide)
    assert(ok, "Polestar refused the guide: " .. tostring(refused))
    return guide.id
end

local function newId()
    local base = "g" .. tostring(time())
    local id, n = base, 1
    while plans[id] do
        n = n + 1
        id = base .. "-" .. n
    end
    return id
end

local function saved()
    if type(ns.db) ~= "table" then
        return nil
    end
    if type(ns.db.polestarGuides) ~= "table" then
        ns.db.polestarGuides = {}
    end
    return ns.db.polestarGuides
end

-- Keep the plan, newest first, at most MAX_SAVED.
local function save(id, plan)
    local list = saved()
    if not list then
        return
    end
    for i = #list, 1, -1 do
        if type(list[i]) ~= "table" or list[i].id == id then
            table.remove(list, i)
        end
    end
    table.insert(list, 1, { id = id, title = plan.title, steps = plan.steps, savedAt = time() })
    while #list > MAX_SAVED do
        table.remove(list)
    end
end

-- Register the saved Wisp guides again (WispAI's ADDON_LOADED, after
-- Polestar has loaded), so a tab Polestar restores at login still has its
-- guide. A guide that no longer registers is dropped from the saved list.
-- Returns the count restored and "id: reason" for each one dropped.
function ns.Integrations.RestorePolestarGuides()
    local polestar, _, lookup = api()
    local list = saved()
    if not polestar or not list then
        return 0, {}
    end
    local restored, failures = 0, {}
    for i = #list, 1, -1 do
        local entry = list[i]
        local valid = type(entry) == "table"
            and type(entry.id) == "string"
            and entry.id:match(ID_PATTERN)
            and type(entry.title) == "string"
            and type(entry.steps) == "table"
        local err = not valid and "invalid saved guide" or nil
        if valid then
            plans[entry.id] = { title = entry.title, steps = entry.steps }
            valid, err = pcall(register, polestar, lookup, entry.id)
        end
        if valid then
            restored = restored + 1
        else
            local id = type(entry) == "table" and type(entry.id) == "string" and entry.id or nil
            if id then
                plans[id] = nil
            end
            failures[#failures + 1] = tostring(id or "?") .. ": " .. tostring(err)
            table.remove(list, i)
        end
    end
    return restored, failures
end

-- args: { id?, title, steps = { { title?, note?, goals = { wire goal, ... } } }, open? }
-- Creates a guide, or with the id of an earlier Wisp guide replaces its steps
-- in place. Opens it in the active tab unless open is false.
function ns.Integrations.CreatePolestarGuide(args)
    local polestar, public, lookup, engine = api()
    assert(polestar, "Polestar is not loaded or its guide API version is not supported")
    assert(type(args.title) == "string" and args.title ~= "", "A guide needs a title")
    local id = args.id
    if id ~= nil then
        assert(
            type(id) == "string" and #id <= MAX_ID_BYTES and id:match(ID_PATTERN),
            "Guide ids are 1-32 lower-case letters, digits or hyphens"
        )
    else
        id = newId()
    end
    local steps = stepsOf(args.steps)
    local previous = plans[id]
    plans[id] = { title = args.title, steps = args.steps }
    local ok, guideId = pcall(register, polestar, lookup, id)
    if not ok then
        plans[id] = previous
        error(guideId, 0)
    end
    local updated = false
    if previous then
        local replaced, reason = public.ReplaceSteps(guideId, steps)
        if not replaced then
            -- The menu already holds the new guide while its tab keeps the old
            -- steps: register the earlier plan again so both agree.
            plans[id] = previous
            pcall(register, polestar, lookup, id)
            error("Polestar could not update the open guide: " .. tostring(reason), 0)
        end
        updated = true
    end
    save(id, plans[id])
    local opened = false
    if args.open ~= false then
        opened = engine.SetGuide(guideId) == true
    end
    local goals = 0
    for _, step in ipairs(steps) do
        goals = goals + #step.goals
    end
    return {
        id = id,
        guideId = guideId,
        title = args.title,
        steps = #steps,
        goals = goals,
        updated = updated,
        opened = opened,
        note = "Polestar tracks the goals and leads the arrow; the player can tick or skip steps there. Pass this id with new steps to update the same guide.",
    }
end
