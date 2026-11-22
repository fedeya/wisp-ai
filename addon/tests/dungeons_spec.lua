local helper = require("addon.tests.support")

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

-- A double that follows Polestar.Dungeons' documented reads.
local function polestar(loaded)
    local rfc = {
        key = "ragefire-chasm",
        name = "Sima Ígnea",
        kind = "dungeon",
        minLevel = 13,
        maxLevel = 18,
        players = 5,
        zoneName = "Orgrimmar",
        entrance = { map = 1454, x = 49.3, y = 95.1 },
        quests = { A = 0, H = 8 },
        attune = { A = 0, H = 0 },
    }
    local thanes = {
        key = "the-hall-of-thanes",
        name = "La Sala de los Thanes",
        kind = "dungeon",
        forever = true,
        minLevel = 13,
        maxLevel = 18,
        players = 5,
        zoneName = "Forjaz",
        entrance = { map = 1455, x = 40, y = 50 },
        quests = { A = 5, H = 0 },
        attune = { A = 0, H = 0 },
    }
    local quests = {
        {
            id = 5723,
            title = "Poner a prueba la fuerza del enemigo",
            level = 15,
            minLevel = 9,
            faction = "H",
            start = { kind = "npc", name = "Rahauro", map = 1456, x = 70.6, y = 30.7 },
            finish = { kind = "npc", name = "Rahauro", map = 1456, x = 70.6, y = 30.7 },
            rewards = {
                items = { { id = 15449, name = "Ghostly Bracers", quality = 2, choice = true } },
                xp = 1350,
            },
        },
        {
            id = 5722,
            title = "Buscando la bolsa perdida",
            level = 16,
            minLevel = 10,
            faction = "H",
        },
        { id = 5761, title = "Matanza de lo pestilente", level = 16, minLevel = 9, faction = "H" },
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
                return { rfc, thanes }
            end,
            Find = function(text)
                return (text == "Sima Ígnea" or text == "RFC") and "ragefire-chasm" or nil
            end,
            Get = function(key)
                return key == "ragefire-chasm" and rfc or nil
            end,
            BestAt = function(key)
                return key == "ragefire-chasm" and 15 or nil
            end,
            EnemyEntrance = function(key, side)
                return key == "the-hall-of-thanes"
                        and side == "H"
                        and "Entrance in Alliance territory (in Ironforge)"
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
                        quests = { { id = 5722, how = "kill" } },
                    },
                }
            end,
        },
    }
end

it("lists Forever dungeons with ranges, entrances and enemy territory for this faction", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local result = env.ns.Integrations.InspectIntegration({ kind = "dungeons", args = {} })
    assert.equals("available", result.status)
    local data = result.data
    assert.equals("Polestar dungeon journal", data.source)
    assert.equals(21, data.characterLevel)
    assert.equals("H", data.faction)
    local rfc, thanes = data.dungeons[1], data.dungeons[2]
    assert.equals(13, rfc.minLevel)
    assert.equals(18, rfc.maxLevel)
    assert.equals(15, rfc.bestLevel)
    assert.same({ mapId = 1454, x = 49.3, y = 95.1 }, rfc.entrance)
    assert.equals(8, rfc.questCount)
    assert.is_nil(rfc.enemyTerritory)
    assert.is_nil(rfc.attunements)
    assert.is_true(thanes.newInForever)
    assert.is_nil(thanes.questCount)
    assert.equals("Entrance in Alliance territory (in Ironforge)", thanes.enemyTerritory)
end)

it("reads one dungeon's quests with this character's state and its boss drops", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local data = env.ns.Integrations.InspectIntegration({
        kind = "dungeons",
        args = { dungeon = "RFC", questLimit = 2 },
    }).data
    local dungeon = data.dungeon
    assert.equals("Sima Ígnea", dungeon.name)
    assert.equals(2, #dungeon.quests)
    assert.is_true(data.moreQuests)
    local first = dungeon.quests[1]
    assert.equals("in_log", first.state)
    assert.equals("Mata a 8 Troggs Furia Ardiente", first.objectives)
    assert.same({ name = "Rahauro", mapId = 1456, x = 70.6, y = 30.7 }, first.start)
    assert.same(
        { id = 15449, name = "Ghostly Bracers", quality = 2, choice = true },
        first.rewards.items[1]
    )
    assert.equals(1350, first.rewards.xp)
    assert.equals("completed", dungeon.quests[2].state)
    local boss = dungeon.bosses[2]
    assert.equals("Taragaman el Hambriento", boss.name)
    assert.same({ id = 14145, name = "Garra de cueva", quality = 3 }, boss.loot[1])
    assert.same({ id = 14149, name = "Collar de Taragaman" }, boss.loot[2])
    assert.same({ 5722 }, boss.quests)
    assert.is_nil(dungeon.bosses[1].loot)
end)

it("marks quests this character cannot take", function()
    local env = helper.env()
    setup(env)
    env.Polestar = polestar()
    local data = env.ns.Integrations.InspectIntegration({
        kind = "dungeons",
        args = { dungeon = "RFC" },
    }).data
    assert.is_false(data.moreQuests)
    assert.equals("class", data.dungeon.quests[3].notForThisCharacter)
end)

it(
    "reports missing Polestar, a journal that cannot load and unknown names as unavailable",
    function()
        local env = helper.env()
        setup(env)
        local result = env.ns.Integrations.InspectIntegration({ kind = "dungeons", args = {} })
        assert.equals("unavailable", result.status)
        assert.matches("not installed", result.error)

        env.Polestar = polestar(false)
        result = env.ns.Integrations.InspectIntegration({ kind = "dungeons", args = {} })
        assert.equals("unavailable", result.status)
        assert.matches("combat", result.error)

        env.Polestar = polestar()
        result = env.ns.Integrations.InspectIntegration({
            kind = "dungeons",
            args = { dungeon = "Karazhan" },
        })
        assert.equals("unavailable", result.status)
        assert.matches("Karazhan", result.error)
    end
)
