-- Forever dungeon facts in layers, so no single addon is required:
--   1. The game's group finder lists every dungeon with its suggested level
--      range and group size, in the client's language (always available).
--   2. QuestieDB Forever's dungeon table gives entrances, when Questie is loaded.
--   3. Polestar's dungeon journal, when installed, adds the best level,
--      enemy-territory notes, raids, missing entrances, quests and boss drops.
-- Polestar.Dungeons and Questie's ZoneDB are those addons' own modules, reached
-- through their globals; every read is guarded so a change there only drops
-- that layer.
local _, ns = ...
local sharedText = ns.Shared.Text

local DUNGEON_CATEGORY = 2
local QUEST_LIMIT = 15
local LOOT_LIMIT = 15

-- Instance map ID -> QuestieDB dungeon area ID (game table IDs).
local QUESTIE_AREA = {
    [33] = 209, -- Shadowfang Keep
    [34] = 717, -- The Stockade
    [36] = 1581, -- The Deadmines
    [43] = 718, -- Wailing Caverns
    [47] = 491, -- Razorfen Kraul
    [48] = 719, -- Blackfathom Deeps
    [70] = 1337, -- Uldaman
    [90] = 721, -- Gnomeregan
    [109] = 1477, -- The Temple of Atal'Hakkar
    [129] = 722, -- Razorfen Downs
    [189] = 796, -- Scarlet Monastery
    [209] = 1176, -- Zul'Farrak
    [229] = 1583, -- Blackrock Spire
    [230] = 1584, -- Blackrock Depths
    [249] = 2159, -- Onyxia's Lair
    [289] = 2057, -- Scholomance
    [329] = 2017, -- Stratholme
    [349] = 2100, -- Maraudon
    [389] = 2437, -- Ragefire Chasm
    [409] = 2717, -- Molten Core
    [429] = 2557, -- Dire Maul
    [469] = 2677, -- Blackwing Lair
    [509] = 3429, -- Ruins of Ahn'Qiraj
    [2959] = 16544, -- City of Dalaran
    [2998] = 16732, -- Excavation Site: Wetlands
    [2999] = 16611, -- Ruins of Lordaeron
    [3065] = 16919, -- The Hall of Thanes
}

local function text(value, bytes)
    return type(value) == "string" and sharedText.TruncateUtf8Bytes(value, bytes or 160) or nil
end

local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, first, second = pcall(fn, ...)
    if ok then
        return first, second
    end
    return nil
end

local function level(value)
    return type(value) == "number" and value > 0 and value or nil
end

local function side()
    local faction = UnitFactionGroup and UnitFactionGroup("player")
    return faction == "Alliance" and "A" or faction == "Horde" and "H" or nil
end

-- Layer 1: the group finder's dungeon activities.
local function activities()
    local lfg = C_LFGList
    if not (lfg and lfg.GetAvailableActivities and lfg.GetActivityInfoTable) then
        return {}
    end
    local out = {}
    for _, id in ipairs(call(lfg.GetAvailableActivities) or {}) do
        local info = call(lfg.GetActivityInfoTable, id)
        if type(info) == "table" and info.categoryID == DUNGEON_CATEGORY then
            out[#out + 1] = info
        end
    end
    return out
end

-- Layer 2: QuestieDB's entrances, in Forever map percentages.
local function questieEntrance()
    if not (QuestieLoader and QuestieLoader.ImportModule) then
        return nil
    end
    local ok, zoneDB = pcall(QuestieLoader.ImportModule, QuestieLoader, "ZoneDB")
    if
        not (
            ok
            and type(zoneDB) == "table"
            and zoneDB.GetDungeonLocation
            and zoneDB.GetUiMapIdByAreaId
        )
    then
        return nil
    end
    return function(instanceMap)
        local area = QUESTIE_AREA[instanceMap]
        local points = area and call(zoneDB.GetDungeonLocation, zoneDB, area)
        local out = {}
        for _, point in ipairs(type(points) == "table" and points or {}) do
            local mapId = type(point) == "table"
                and call(zoneDB.GetUiMapIdByAreaId, zoneDB, point[1])
            if mapId and type(point[2]) == "number" and type(point[3]) == "number" then
                out[#out + 1] =
                    { mapId = mapId, x = point[2], y = point[3], source = "QuestieDB Forever" }
            end
        end
        return out[1] and out or nil
    end
end

-- Layer 3: Polestar's journal, or nil with the reason it is missing.
local function polestar()
    local dungeons = type(Polestar) == "table" and Polestar.Dungeons
    if
        not (
            type(dungeons) == "table"
            and type(dungeons.List) == "function"
            and type(dungeons.Get) == "function"
        )
    then
        return nil, "not installed"
    end
    if type(dungeons.Load) == "function" then
        local ok, loaded, reason = pcall(dungeons.Load)
        if not (ok and loaded) then
            return nil, tostring(ok and reason or loaded)
        end
    end
    return dungeons
end

local function point(value)
    if type(value) ~= "table" or type(value.map) ~= "number" then
        return nil
    end
    return {
        name = text(value.name),
        mapId = value.map,
        x = value.x,
        y = value.y,
        inside = value.inside or nil,
    }
end

local function questState(id)
    if not C_QuestLog then
        return nil
    end
    if C_QuestLog.IsQuestFlaggedCompleted and C_QuestLog.IsQuestFlaggedCompleted(id) then
        return "completed"
    end
    if C_QuestLog.IsOnQuest and C_QuestLog.IsOnQuest(id) then
        return "in_log"
    end
    return nil
end

-- Names and quality come from the item cache when the game has them, then
-- from Polestar's names pack; an unnamed item keeps its ID.
local function item(id, fallback)
    local name, quality
    if C_Item and C_Item.GetItemInfo then
        local ok, itemName, _, itemQuality = pcall(C_Item.GetItemInfo, id)
        if ok then
            name, quality = itemName, itemQuality
        end
    end
    if not name and type(Polestar) == "table" and type(Polestar.Names) == "table" then
        name = call(Polestar.Names.Item, id)
    end
    return { id = id, name = text(name or fallback), quality = quality }
end

local function rewards(value)
    if type(value) ~= "table" then
        return nil
    end
    local items = {}
    for _, reward in ipairs(value.items or {}) do
        if type(reward) == "table" and type(reward.id) == "number" then
            local entry = item(reward.id, reward.name)
            entry.quality = entry.quality or reward.quality
            entry.choice = reward.choice or nil
            items[#items + 1] = entry
        end
    end
    return { items = items[1] and items or nil, xp = value.xp, money = value.money }
end

local function quests(journal, key, faction, limit)
    local out, more = {}, false
    for _, quest in ipairs(call(journal.Quests, key, faction) or {}) do
        if type(quest) == "table" and type(quest.id) == "number" then
            if #out >= limit then
                more = true
                break
            end
            local _, blocked = call(journal.QuestFor, quest)
            out[#out + 1] = {
                id = quest.id,
                title = text(quest.title),
                level = quest.level,
                minLevel = quest.minLevel,
                state = questState(quest.id),
                notForThisCharacter = blocked,
                startsInside = quest.inside or nil,
                objectives = text(call(journal.ObjectiveText, quest), 400),
                start = point(quest.start),
                finish = point(quest.finish),
                startItem = type(quest.startItem) == "table" and text(quest.startItem.name) or nil,
                rewards = rewards(quest.rewards),
            }
        end
    end
    return out, more
end

local function bosses(journal, key)
    local out = {}
    for _, boss in ipairs(call(journal.Bosses, key) or {}) do
        if type(boss) == "table" then
            local loot = {}
            for _, id in ipairs(boss.loot or {}) do
                if type(id) == "number" and #loot < LOOT_LIMIT then
                    loot[#loot + 1] = item(id)
                end
            end
            local questIds = {}
            for _, quest in ipairs(boss.quests or {}) do
                if type(quest) == "table" and type(quest.id) == "number" then
                    questIds[#questIds + 1] = quest.id
                end
            end
            out[#out + 1] = {
                name = text(boss.name),
                level = boss.level,
                role = boss.role,
                loot = loot[1] and loot or nil,
                moreLoot = boss.loot and #boss.loot > #loot or nil,
                quests = questIds[1] and questIds or nil,
            }
        end
    end
    return out
end

-- One entry per group finder activity (a wing is its own activity), then the
-- journal's dungeons and raids the group finder does not list.
local function entries(journal, faction)
    local byMap, out = {}, {}
    for _, summary in ipairs(journal and call(journal.List) or {}) do
        if type(summary) == "table" and summary.map then
            byMap[summary.map] = summary
        end
    end
    local entrance = questieEntrance()
    local listed = {}
    local function add(entry, summary)
        if summary then
            local questCount = type(summary.quests) == "table"
                    and faction
                    and summary.quests[faction]
                or nil
            local attunements = type(summary.attune) == "table"
                    and faction
                    and summary.attune[faction]
                or nil
            entry.journalKey = summary.key
            entry.kind = summary.kind
            entry.newInForever = summary.forever or nil
            entry.bestLevel = call(journal.BestAt, summary.key)
            entry.zone = text(summary.zoneName)
            entry.enemyTerritory = text(call(journal.EnemyEntrance, summary.key, faction))
            entry.questCount = questCount ~= 0 and questCount or nil
            entry.attunements = attunements ~= 0 and attunements or nil
        end
        entry.entrances = entrance and entrance(entry.instanceMapId)
        local fallback = summary and point(summary.entrance)
        if not entry.entrances and fallback then
            fallback.source, fallback.name = "Polestar", nil
            entry.entrances = { fallback }
        end
        out[#out + 1] = entry
    end
    for _, info in ipairs(activities()) do
        listed[info.mapID] = true
        add({
            name = text(info.fullName),
            instanceMapId = info.mapID,
            minLevel = level(info.minLevelSuggestion),
            maxLevel = level(info.maxLevelSuggestion),
            players = info.maxNumPlayers,
            source = "group finder",
        }, byMap[info.mapID])
    end
    for map, summary in pairs(byMap) do
        if not listed[map] then
            add({
                name = text(summary.name),
                instanceMapId = map,
                minLevel = summary.minLevel,
                maxLevel = summary.maxLevel,
                players = summary.playersMax or summary.players,
                source = "Polestar",
            }, summary)
        end
    end
    table.sort(out, function(a, b)
        local la, lb = a.minLevel or 99, b.minLevel or 99
        if la ~= lb then
            return la < lb
        end
        return (a.name or "") < (b.name or "")
    end)
    return out
end

local function lower(value)
    return type(value) == "string" and value:lower() or ""
end

local function find(list, journal, name)
    local wanted = lower(name)
    for _, entry in ipairs(list) do
        if lower(entry.name) == wanted then
            return entry
        end
    end
    local key = journal and call(journal.Find, name)
    for _, entry in ipairs(list) do
        if key and entry.journalKey == key then
            return entry
        end
    end
    for _, entry in ipairs(list) do
        if wanted ~= "" and lower(entry.name):find(wanted, 1, true) then
            return entry
        end
    end
    return nil
end

function ns.Integrations.ReadDungeons(args)
    local faction = side()
    local journal, missing = polestar()
    local list = entries(journal, faction)
    assert(list[1], "The game listed no dungeons and Polestar's journal is unavailable")
    local result = {
        sources = {
            groupFinder = C_LFGList and C_LFGList.GetAvailableActivities and true or false,
            questie = questieEntrance() and true or false,
            polestar = journal and ns.Integrations._AddonVersion("Polestar")
                or ("unavailable: " .. missing),
        },
        characterLevel = UnitLevel and UnitLevel("player") or nil,
        faction = faction,
    }
    if not args.dungeon then
        result.dungeons = list
        return result
    end
    local entry = find(list, journal, args.dungeon)
    assert(
        entry,
        "No dungeon named "
            .. args.dungeon
            .. "; read the list without a name for the names the game uses"
    )
    result.dungeon = entry
    if journal and entry.journalKey then
        entry.quests, result.moreQuests =
            quests(journal, entry.journalKey, faction, args.questLimit or QUEST_LIMIT)
        entry.bosses = bosses(journal, entry.journalKey)
    else
        result.note =
            "Quests and boss drops come from Polestar's journal, which is unavailable for this dungeon; use the quest and item source tools instead."
    end
    return result
end
