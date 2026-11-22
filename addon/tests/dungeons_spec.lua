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
    [798] = {
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
    [805] = {
        categoryID = 2,
        fullName = "Monasterio Escarlata - Cementerio",
        mapID = 189,
        minLevelSuggestion = 30,
        maxLevelSuggestion = 38,
        maxNumPlayers = 5,
    },
    [7] = {
        categoryID = 116,
        fullName = "Bosque de Argénteos",
        minLevelSuggestion = 8,
        maxLevelSuggestion = 24,
    },
}

local function setup(env, entrances)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function UnitName()
            return "Fedrath"
        end
        function UnitFactionGroup()
            return "Horde"
        end
        function UnitLevel()
            return 21
        end
        function GetRealZoneText(id)
            return id == 409 and "Núcleo de Magma" or ""
        end
        C_LFGList = {
            GetAvailableActivities = function()
                return { 7, 796, 798, 805, 900 }
            end,
            GetActivityInfoTable = function(id)
                return ACTIVITIES[id]
            end,
        }
        C_Map = {
            GetMapInfo = function(id)
                local names =
                    { [1413] = "Los Baldíos", [1454] = "Orgrimmar", [1458] = "Entrañas" }
                return names[id] and { name = names[id] } or nil
            end,
        }
    end
    helper.addon("Character/Dungeons.lua", env)
    env.ns.Data.GroupFinderNames = {
        [796] = "Wailing Caverns",
        [798] = "Ragefire Chasm",
        [805] = "Scarlet Monastery - Graveyard",
        [900] = "Ruins of Lordaeron",
    }
    env.ns.Data.DungeonEntrances = entrances
        or {
            [43] = { name = "Wailing Caverns", raid = false, entrances = { { 1413, 47.7, 35 } } },
            [389] = { name = "Ragefire Chasm", raid = false, entrances = { { 1454, 53, 48.9 } } },
            [2999] = {
                name = "Ruins of Lordaeron",
                raid = false,
                entrances = { { 1458, 72.5, 11.4 } },
            },
            [409] = {
                name = "Molten Core",
                raid = true,
                players = 40,
                entrances = { { 1427, 32, 94.8 }, { 1428, 26.3, 24.6 } },
            },
        }
end

it("lists the group finder's dungeons with ranges and their entrances", function()
    local env = helper.env()
    setup(env)
    local data = env.ns.Character.ReadDungeons({})
    assert.equals(21, data.characterLevel)
    assert.equals("Horde", data.faction)
    assert.is_true(data.groupFinder)
    assert.equals(5, #data.dungeons)
    assert.same({
        name = "Sima Ígnea",
        englishName = "Ragefire Chasm",
        instanceName = "Ragefire Chasm",
        instanceMapId = 389,
        minLevel = 13,
        maxLevel = 18,
        players = 5,
        entrances = { { mapId = 1454, zone = "Orgrimmar", x = 53, y = 48.9 } },
    }, data.dungeons[1])
    assert.equals("Cuevas de los Lamentos", data.dungeons[2].name)
    assert.equals("Ruinas de Lordaeron", data.dungeons[3].name)
end)

it("keeps raids the group finder does not list, with their localized name", function()
    local env = helper.env()
    setup(env)
    local raid = env.ns.Character.ReadDungeons({}).dungeons[5]
    assert.equals("Núcleo de Magma", raid.name)
    assert.equals("Molten Core", raid.englishName)
    assert.is_true(raid.raid)
    assert.equals(40, raid.players)
    assert.is_true(raid.notInGroupFinder)
    assert.equals(2, #raid.entrances)
    assert.is_nil(raid.entrances[1].zone)
end)

it("filters by a localized or English name and reports unknown names", function()
    local env = helper.env()
    setup(env)
    local found = env.ns.Character.ReadDungeons({ dungeon = "sima" }).dungeons
    assert.equals(1, #found)
    assert.equals(389, found[1].instanceMapId)
    found = env.ns.Character.ReadDungeons({ dungeon = "Wailing" }).dungeons
    assert.equals("Cuevas de los Lamentos", found[1].name)
end)

it("matches names regardless of case and accents in UTF-8", function()
    local env = helper.env()
    setup(env)
    for _, query in ipairs({ "sima ígnea", "SIMA ÍGNEA", "sima ignea", "Sima Ígnea" }) do
        local found = env.ns.Character.ReadDungeons({ dungeon = query }).dungeons
        assert.equals(389, found[1].instanceMapId, query)
    end
end)

it("matches a wing by its English name on a localized client", function()
    local env = helper.env()
    setup(env)
    for _, query in ipairs({ "Graveyard", "Scarlet Monastery - Graveyard", "cementerio" }) do
        local found = env.ns.Character.ReadDungeons({ dungeon = query }).dungeons
        assert.equals(1, #found, query)
        assert.equals("Monasterio Escarlata - Cementerio", found[1].name)
    end
end)

it("reports unknown names", function()
    local env = helper.env()
    setup(env)
    assert.has_error(function()
        env.ns.Character.ReadDungeons({ dungeon = "Karazhan" })
    end)
end)

it("lists dungeons without an entrance and fails only when the game lists none", function()
    local env = helper.env()
    setup(env, {})
    local data = env.ns.Character.ReadDungeons({})
    assert.equals(4, #data.dungeons)
    assert.is_nil(data.dungeons[1].entrances)
    env.C_LFGList = nil
    assert.has_error(function()
        env.ns.Character.ReadDungeons({})
    end)
end)

it("says when the group finder cannot be read and keeps the table's instances", function()
    local env = helper.env()
    setup(env)
    env.C_LFGList = nil
    local data = env.ns.Character.ReadDungeons({})
    assert.is_false(data.groupFinder)
    assert.equals(4, #data.dungeons)
    for _, entry in ipairs(data.dungeons) do
        assert.is_nil(entry.minLevel)
        assert.is_true(entry.notInGroupFinder)
    end
end)
