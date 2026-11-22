-- Reads Polestar's Forever dungeon journal: level ranges, entrances, quests
-- and boss drops. Forever adds dungeons and changes ranges, so these facts
-- must come from data that knows Forever, not from general game knowledge.
-- Polestar.Dungeons is Polestar's own journal module, reached through its
-- global namespace; every read is guarded so a change there degrades to an
-- unavailable result instead of an error in the game.
local _, ns = ...
local sharedText = ns.Shared.Text

local QUEST_LIMIT = 15
local LOOT_LIMIT = 15

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

local function journal()
    local polestar = Polestar
    local dungeons = type(polestar) == "table" and polestar.Dungeons
    assert(
        type(dungeons) == "table"
            and type(dungeons.List) == "function"
            and type(dungeons.Find) == "function"
            and type(dungeons.Get) == "function",
        "Polestar's dungeon journal is not installed; use other sources for dungeon facts"
    )
    if type(dungeons.Load) == "function" then
        local ok, loaded, reason = pcall(dungeons.Load)
        assert(
            ok and loaded,
            "Polestar's dungeon journal did not load (" .. tostring(ok and reason or loaded) .. ")"
        )
    end
    return dungeons
end

local function side()
    local faction = UnitFactionGroup and UnitFactionGroup("player")
    return faction == "Alliance" and "A" or faction == "Horde" and "H" or nil
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

local function summary(dungeons, entry, faction)
    local quests = type(entry.quests) == "table" and faction and entry.quests[faction] or nil
    local attunements = type(entry.attune) == "table" and faction and entry.attune[faction] or nil
    return {
        key = entry.key,
        name = text(entry.name),
        kind = entry.kind,
        newInForever = entry.forever or nil,
        minLevel = entry.minLevel,
        maxLevel = entry.maxLevel,
        bestLevel = call(dungeons.BestAt, entry.key),
        players = entry.playersMax or entry.players,
        zone = text(entry.zoneName),
        entrance = point(entry.entrance),
        enemyTerritory = text(call(dungeons.EnemyEntrance, entry.key, faction)),
        questCount = quests ~= 0 and quests or nil,
        attunements = attunements ~= 0 and attunements or nil,
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
    if not name and type(Polestar.Names) == "table" then
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

local function quests(dungeons, key, faction, limit)
    local out, more = {}, false
    for _, quest in ipairs(call(dungeons.Quests, key, faction) or {}) do
        if type(quest) == "table" and type(quest.id) == "number" then
            if #out >= limit then
                more = true
                break
            end
            local _, blocked = call(dungeons.QuestFor, quest)
            out[#out + 1] = {
                id = quest.id,
                title = text(quest.title),
                level = quest.level,
                minLevel = quest.minLevel,
                state = questState(quest.id),
                notForThisCharacter = blocked,
                startsInside = quest.inside or nil,
                objectives = text(call(dungeons.ObjectiveText, quest), 400),
                start = point(quest.start),
                finish = point(quest.finish),
                startItem = type(quest.startItem) == "table" and text(quest.startItem.name) or nil,
                rewards = rewards(quest.rewards),
            }
        end
    end
    return out, more
end

local function bosses(dungeons, key)
    local out = {}
    for _, boss in ipairs(call(dungeons.Bosses, key) or {}) do
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

function ns.Integrations.ReadDungeons(args)
    local dungeons = journal()
    local faction = side()
    local result = {
        source = "Polestar dungeon journal",
        version = ns.Integrations._AddonVersion("Polestar"),
        characterLevel = UnitLevel and UnitLevel("player") or nil,
        faction = faction,
    }
    if not args.dungeon then
        local list = {}
        for _, entry in ipairs(call(dungeons.List) or {}) do
            if type(entry) == "table" and entry.key then
                list[#list + 1] = summary(dungeons, entry, faction)
            end
        end
        assert(list[1], "Polestar's dungeon journal is empty")
        result.dungeons = list
        return result
    end
    local key = call(dungeons.Find, args.dungeon)
    local entry = key and call(dungeons.Get, key)
    assert(
        entry,
        "Polestar knows no dungeon or raid named "
            .. args.dungeon
            .. "; read the list without a name for the names it knows"
    )
    entry.key = entry.key or key
    result.dungeon = summary(dungeons, entry, faction)
    result.dungeon.quests, result.moreQuests =
        quests(dungeons, key, faction, args.questLimit or QUEST_LIMIT)
    result.dungeon.bosses = bosses(dungeons, key)
    return result
end
