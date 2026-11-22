local helper = require("addon.tests.support")

-- Group finder activities as Forever 1.60.1 returns them (category 2: dungeons).
local ACTIVITIES = {
    [796] = {
        categoryID = 2,
        fullName = "Cuevas de los Lamentos",
        mapID = 43,
        minLevelSuggestion = 15,
        maxLevelSuggestion = 24,
        maxNumPlayers = 5,
    },
    [801] = {
        categoryID = 2,
        fullName = "Sima Ígnea",
        mapID = 389,
        minLevelSuggestion = 13,
        maxLevelSuggestion = 18,
        maxNumPlayers = 5,
    },
    [900] = {
        categoryID = 2,
        fullName = "Ruinas de Lordaeron",
        mapID = 2999,
        minLevelSuggestion = 15,
        maxLevelSuggestion = 22,
        maxNumPlayers = 5,
    },
    [901] = {
        categoryID = 2,
        fullName = "Bastión de Krol'dok",
        mapID = 3039,
        minLevelSuggestion = 40,
        maxLevelSuggestion = 47,
        maxNumPlayers = 5,
    },
    [7] = {
        categoryID = 116,
        fullName = "Bosque de Argénteos",
        minLevelSuggestion = 8,
        maxLevelSuggestion = 24,
    },
}

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function UnitFactionGroup()
            return "Horde"
        end
        function UnitLevel()
            return 21
        end
        C_LFGList = {
            GetAvailableActivities = function()
                return { 7, 796, 801, 900, 901 }
            end,
            GetActivityInfoTable = function(id)
                return ACTIVITIES[id]
            end,
        }
        C_QuestLog = {
            IsQuestFlaggedCompleted = function(id)
                return id == 5722
            end,
            IsOnQuest = function(id)
                return id == 5723
            end,
        }
        C_Item = {
            GetItemInfo = function(id)
                if id == 14145 then
                    return "Garra de cueva", nil, 3
                end
            end,
        }
    end
    helper.addon("Integrations/Integrations.lua", env)
    helper.addon("Integrations/Dungeons.lua", env)
end

-- QuestieDB's ZoneDB: dungeon area -> {parent area, x, y}; area -> UI map.
local function questie()
    local zoneDB = {
        GetDungeonLocation = function(_, area)
            return ({ [718] = { { 17, 46, 36.5 } }, [2437] = { { 1637, 52.6, 49 } } })[area]
        end,
        GetUiMapIdByAreaId = function(_, area)
            return ({ [17] = 1413, [1637] = 1454 })[area]
        end,
    }
    return {
        ImportModule = function(_, name)
            return name == "ZoneDB" and zoneDB or nil
        end,
    }
end

-- A double that follows Polestar.Dungeons' journal reads.
local function polestar(loaded)
    local rfc = {
        key = "ragefire-chasm",
        name = "Sima Ígnea",
        kind = "dungeon",
        map = 389,
        minLevel = 13,
        maxLevel = 18,
        players = 5,
        zoneName = "Orgrimmar",
        entrance = { map = 1454, x = 49.3, y = 95.1 },
        quests = { A = 0, H = 8 },
        attune = { A = 0, H = 0 },
    }
    local lordaeron = {
        key = "ruins-of-lordaeron",
        name = "Ruinas de Lordaeron",
        kind = "dungeon",
        forever = true,
        map = 2999,
        minLevel = 15,
        maxLevel = 22,
        entrance = { map = 1458, x = 72.7, y = 11.5 },
        quests = { A = 5, H = 10 },
    }
    local molten = {
        key = "molten-core",
        name = "Núcleo de Magma",
        kind = "raid",
        map = 409,
        minLevel = 60,
        maxLevel = 60,
        players = 40,
        entrance = { map = 1428, x = 34.8, y = 85.3 },
    }
    local quests = {
        {
            id = 5723,
            title = "Poner a prueba la fuerza del enemigo",
            level = 15,
            minLevel = 9,
            start = { kind = "npc", name = "Rahauro", map = 1456, x = 70.6, y = 30.7 },
            rewards = {
                items = { { id = 15449, name = "Ghostly Bracers", quality = 2, choice = true } },
                xp = 1350,
            },
        },
        { id = 5722, title = "Buscando la bolsa perdida", level = 16 },
        { id = 5761, title = "Matanza de lo pestilente", level = 16 },
    }
    return {
        Names = {
            Item = function(id)
                return id == 14149 and "Collar de Taragaman" or nil
            end,
        },
        Dungeons = {
            Load = function()
                if loaded == false then
                    return false, "combat"
                end
                return true
            end,
            List = function()
                return { rfc, lordaeron, molten }
            end,
            Find = function(text)
                return text == "RFC" and "ragefire-chasm" or nil
            end,
            Get = function(key)
                return key == "ragefire-chasm" and rfc or nil
            end,
            BestAt = function(key)
                return key == "ragefire-chasm" and 15 or nil
            end,
            EnemyEntrance = function(key, side)
                return key == "ruins-of-lordaeron" and side == "A" and "Entrance in Horde territory"
                    or nil
            end,
            Quests = function()
                return quests
            end,
            QuestFor = function(quest)
                if quest.id == 5761 then
                    return { classes = { "WARLOCK" } }, "class"
                end
            end,
            ObjectiveText = function(quest)
                return quest.id == 5723 and "Mata a 8 Troggs Furia Ardiente" or nil
            end,
            Bosses = function()
                return {
                    { name = "Oggleflint", level = 16, loot = {} },
                    {
                        name = "Taragaman el Hambriento",
                        level = 16,
                        loot = { 14145, 14149 },
                        quests = { { id = 5722 } },
                    },
                }
            end,
        },
    }
end

local function read(env, args)
    return env.ns.Integrations.InspectIntegration({ kind = "dungeons", args = args or {} })
end

local function byName(list, name)
    for _, entry in ipairs(list) do
        if entry.name == name then
            return entry
        end
    end
end

it("lists the game's dungeons and ranges without Questie or Polestar", function()
    local env = helper.env()
    setup(env)
    local result = read(env)
    assert.equals("available", result.status)
    local data = result.data
    assert.equals(21, data.characterLevel)
    assert.is_true(data.sources.groupFinder)
    assert.is_false(data.sources.questie)
    assert.equals("unavailable: not installed", data.sources.polestar)
    assert.equals(4, #data.dungeons)
    assert.same({
        name = "Sima Ígnea",
        instanceMapId = 389,
        minLevel = 13,
        maxLevel = 18,
        players = 5,
        source = "group finder",
    }, data.dungeons[1])
    assert.equals("Bastión de Krol'dok", data.dungeons[4].name)

    data = read(env, { dungeon = "sima" }).data
    assert.equals(389, data.dungeon.instanceMapId)
    assert.is_nil(data.dungeon.quests)
    assert.matches("Polestar", data.note)
end)

it("adds entrances from QuestieDB on the native map", function()
    local env = helper.env()
    setup(env)
    env.QuestieLoader = questie()
    local data = read(env).data
    assert.is_true(data.sources.questie)
    local caverns = byName(data.dungeons, "Cuevas de los Lamentos")
    assert.same(
        { { mapId = 1413, x = 46, y = 36.5, source = "QuestieDB Forever" } },
        caverns.entrances
    )
    assert.is_nil(byName(data.dungeons, "Bastión de Krol'dok").entrances)
end)

it(
    "enriches with Polestar, keeps the game's ranges and adds what the group finder lacks",
    function()
        local env = helper.env()
        setup(env)
        env.QuestieLoader = questie()
        env.Polestar = polestar()
        local list = read(env).data.dungeons
        local rfc = byName(list, "Sima Ígnea")
        assert.equals(15, rfc.bestLevel)
        assert.equals(8, rfc.questCount)
        assert.equals("QuestieDB Forever", rfc.entrances[1].source)
        local lordaeron = byName(list, "Ruinas de Lordaeron")
        assert.is_true(lordaeron.newInForever)
        assert.same(
            { { mapId = 1458, x = 72.7, y = 11.5, source = "Polestar" } },
            lordaeron.entrances
        )
        local molten = byName(list, "Núcleo de Magma")
        assert.equals("raid", molten.kind)
        assert.equals("Polestar", molten.source)
        assert.equals(list[#list], molten)
    end
)

it("reads one dungeon's quests and boss drops from Polestar", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local data = read(env, { dungeon = "RFC", questLimit = 2 }).data
    local dungeon = data.dungeon
    assert.equals("Sima Ígnea", dungeon.name)
    assert.is_true(data.moreQuests)
    assert.equals("in_log", dungeon.quests[1].state)
    assert.equals("Mata a 8 Troggs Furia Ardiente", dungeon.quests[1].objectives)
    assert.same(
        { id = 15449, name = "Ghostly Bracers", quality = 2, choice = true },
        dungeon.quests[1].rewards.items[1]
    )
    assert.equals("completed", dungeon.quests[2].state)
    local boss = dungeon.bosses[2]
    assert.same({ id = 14145, name = "Garra de cueva", quality = 3 }, boss.loot[1])
    assert.same({ id = 14149, name = "Collar de Taragaman" }, boss.loot[2])
    assert.same({ 5722 }, boss.quests)
    assert.is_nil(dungeon.bosses[1].loot)

    data = read(env, { dungeon = "RFC" }).data
    assert.equals("class", data.dungeon.quests[3].notForThisCharacter)
end)

it("drops a Polestar journal that cannot load and reports unknown names", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar(false)
    local data = read(env).data
    assert.equals("unavailable: combat", data.sources.polestar)
    assert.equals(4, #data.dungeons)

    local result = read(env, { dungeon = "Karazhan" })
    assert.equals("unavailable", result.status)
    assert.matches("Karazhan", result.error)

    env.C_LFGList = nil
    result = read(env)
    assert.equals("unavailable", result.status)
end)
