local _, ns = ...

-- Suggestion chips for an empty chat. Each pool holds locale keys; the text is
-- looked up when shown. Which pools apply depends on the player's situation, so
-- the chips change with level, place and how much Wisp has been used.
local POOLS = {
    -- First conversations: learn what Wisp is for.
    onboarding = {
        "suggestion.whatDoYouKnow",
        "suggestion.howToUse",
        "suggestion.whatToAsk",
        "suggestion.showExample",
    },
    general = {
        "suggestion.whatCanYouDo",
        "suggestion.whatNext",
        "suggestion.reviewGear",
        "suggestion.findUpgrades",
        "suggestion.planTalents",
        "suggestion.explainRotation",
        "suggestion.makeGold",
        "suggestion.pickProfessions",
        "suggestion.questsHere",
        "suggestion.whereToLevel",
        "suggestion.cleanBags",
        "suggestion.classStrengths",
    },
    newToClass = {
        "suggestion.newClassTips",
        "suggestion.whichAbilities",
        "suggestion.firstSteps",
    },
    leveling = {
        "suggestion.levelFaster",
        "suggestion.dungeonForLevel",
        "suggestion.nextTraining",
        "suggestion.zoneForLevel",
    },
    mount = {
        "suggestion.getMount",
    },
    maxLevel = {
        "suggestion.preRaidGear",
        "suggestion.readyToRaid",
        "suggestion.endgameFarm",
        "suggestion.endgameGoals",
    },
    instance = {
        "suggestion.instanceTips",
        "suggestion.instanceLoot",
        "suggestion.instanceQuests",
    },
    group = {
        "suggestion.groupRole",
        "suggestion.groupQuests",
    },
    dead = {
        "suggestion.avoidDying",
        "suggestion.whyDied",
    },
    resting = {
        "suggestion.townErrands",
        "suggestion.auctionHouse",
        "suggestion.trainNow",
    },
    lateNight = {
        "suggestion.shortSession",
    },
}
-- Below this many conversations the player still gets onboarding chips.
local NEWCOMER_CHATS = 3
local DEFAULT_MAX_LEVEL = 60

local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, a, b = pcall(fn, ...)
    if ok then
        return a, b
    end
    return nil
end

-- Which situational pools apply right now. Every read is optional, so the
-- chips still work outside the game or on clients without an API.
local function situation()
    local pools = {}
    local level = tonumber(call(UnitLevel, "player"))
    local maxLevel = tonumber(call(GetMaxPlayerLevel)) or DEFAULT_MAX_LEVEL
    if level and level > 0 then
        if level >= maxLevel then
            pools[#pools + 1] = "maxLevel"
        elseif level < 10 then
            pools[#pools + 1] = "newToClass"
        else
            pools[#pools + 1] = "leveling"
        end
        if level >= 38 and level <= 42 then
            pools[#pools + 1] = "mount"
        end
    end
    local inInstance, kind = call(IsInInstance)
    if inInstance and (kind == "party" or kind == "raid") then
        pools[#pools + 1] = "instance"
    elseif call(IsInGroup) then
        pools[#pools + 1] = "group"
    end
    if call(UnitIsDeadOrGhost, "player") then
        pools[#pools + 1] = "dead"
    end
    if call(IsResting) then
        pools[#pools + 1] = "resting"
    end
    local hour = tonumber(date and date("%H") or "")
    if hour and (hour < 5 or hour >= 23) then
        pools[#pools + 1] = "lateNight"
    end
    return pools
end

local function isNewcomer()
    return #(ns.chats or {}) < NEWCOMER_CHATS
end

-- Moves one random key from candidates into picked, skipping repeats.
local function take(candidates, picked, used)
    local open = {}
    for _, key in ipairs(candidates) do
        if not used[key] then
            open[#open + 1] = key
        end
    end
    if #open == 0 then
        return false
    end
    local key = open[math.random(#open)]
    picked[#picked + 1] = key
    used[key] = true
    return true
end

local function collect(names)
    local keys = {}
    for _, name in ipairs(names) do
        for _, key in ipairs(POOLS[name]) do
            keys[#keys + 1] = key
        end
    end
    return keys
end

--- Picks `count` distinct suggestion keys for a new chat.
--- Newcomers start with "What can you do?" and an onboarding prompt. Otherwise
--- the first chip comes from the player's situation (dungeon, level, death...)
--- when one applies, and the rest mix situational and general prompts.
---@param count integer
---@return string[] keys locale keys, in display order
function ns.UI.Suggestions.Pick(count)
    local picked, used = {}, {}
    local situational = collect(situation())
    local general = POOLS.general
    if isNewcomer() then
        picked[1], used["suggestion.whatCanYouDo"] = "suggestion.whatCanYouDo", true
        take(POOLS.onboarding, picked, used)
    elseif #situational > 0 then
        take(situational, picked, used)
    end
    -- Situational prompts are weighted over general ones when filling the rest.
    local mixed = {}
    for _ = 1, 2 do
        for _, key in ipairs(situational) do
            mixed[#mixed + 1] = key
        end
    end
    for _, key in ipairs(general) do
        mixed[#mixed + 1] = key
    end
    while #picked < count and take(mixed, picked, used) do
    end
    return picked
end

--- Every key the picker can return, for locale checks.
function ns.UI.Suggestions.AllKeys()
    local names = {}
    for name in pairs(POOLS) do
        names[#names + 1] = name
    end
    table.sort(names)
    return collect(names)
end
