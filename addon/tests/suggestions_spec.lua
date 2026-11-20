local helper = require("addon.tests.support")

-- Loads the picker with a player in the given situation.
local function picker(player)
    local env = helper.env()
    env.ns = helper.namespace({ chats = player.chats or {} })
    env.UnitLevel = player.level and function()
        return player.level
    end
    env.GetMaxPlayerLevel = function()
        return 60
    end
    env.IsInInstance = function()
        return player.instance ~= nil, player.instance or "none"
    end
    env.IsInGroup = function()
        return player.group == true
    end
    env.UnitIsDeadOrGhost = function()
        return player.dead == true
    end
    env.IsResting = function()
        return player.resting == true
    end
    env.date = function()
        return "14"
    end
    helper.addon("UI/Suggestions.lua", env)
    return env.ns
end

local function chats(count)
    local list = {}
    for index = 1, count do
        list[index] = { id = "chat" .. index }
    end
    return list
end

local function contains(list, value)
    for _, item in ipairs(list) do
        if item == value then
            return true
        end
    end
    return false
end

it("starts newcomers with what Wisp can do and an onboarding prompt", function()
    local ns = picker({ level = 12 })
    local onboarding = {
        "suggestion.whatDoYouKnow",
        "suggestion.howToUse",
        "suggestion.whatToAsk",
        "suggestion.showExample",
    }
    for _ = 1, 20 do
        local keys = ns.UI.Suggestions.Pick(3)
        assert.equal(3, #keys)
        assert.equal("suggestion.whatCanYouDo", keys[1])
        assert.is_true(contains(onboarding, keys[2]), keys[2])
    end
end)

it("leads with the player's situation once they have used Wisp", function()
    local cases = {
        { player = { level = 60, instance = "party" }, pools = { "instance", "maxLevel" } },
        { player = { level = 25, dead = true }, pools = { "dead", "leveling" } },
        { player = { level = 5, resting = true }, pools = { "newToClass", "resting" } },
        { player = { level = 40 }, pools = { "leveling", "mount" } },
    }
    local situational = {
        instance = { "instanceTips", "instanceLoot", "instanceQuests" },
        maxLevel = { "preRaidGear", "readyToRaid", "endgameFarm", "endgameGoals" },
        dead = { "avoidDying", "whyDied" },
        leveling = { "levelFaster", "dungeonForLevel", "nextTraining", "zoneForLevel" },
        newToClass = { "newClassTips", "whichAbilities", "firstSteps" },
        resting = { "townErrands", "auctionHouse", "trainNow" },
        mount = { "getMount" },
    }
    for _, case in ipairs(cases) do
        case.player.chats = chats(5)
        local ns = picker(case.player)
        local allowed = {}
        for _, pool in ipairs(case.pools) do
            for _, name in ipairs(situational[pool]) do
                allowed[#allowed + 1] = "suggestion." .. name
            end
        end
        for _ = 1, 20 do
            local keys = ns.UI.Suggestions.Pick(3)
            assert.equal(3, #keys)
            assert.is_true(contains(allowed, keys[1]), keys[1])
            assert.is_false(keys[1] == keys[2] or keys[2] == keys[3] or keys[1] == keys[3])
        end
    end
end)

it("falls back to general prompts outside the game", function()
    local env = helper.env()
    env.ns = helper.namespace({ chats = chats(5) })
    for _, name in ipairs({ "UnitLevel", "IsInInstance", "IsInGroup", "IsResting" }) do
        env[name] = nil
    end
    helper.addon("UI/Suggestions.lua", env)
    local keys = env.ns.UI.Suggestions.Pick(3)
    assert.equal(3, #keys)
end)

it("has English text for every suggestion", function()
    local ns = picker({})
    local english = ns.Locales.enUS
    for _, key in ipairs(ns.UI.Suggestions.AllKeys()) do
        assert.is_string(english[key], key)
    end
end)
