-- Names the NPCs, quests and spells behind item sources and reads cached
-- auction prices in one request, so the bridge can answer for many items.
local _, ns = ...
local sharedText = ns.Shared.Text

-- An incompatible QuestieDB may throw from RequireContract; that only makes
-- names unavailable and must not cancel the independent price and spell reads.
local function questieDB()
    local db = LibQuestieDB
    if not (db and db.flavor and db.flavor.expansion == "Forever" and db.RequireContract) then
        return nil
    end
    local ok, compatible = pcall(db.RequireContract, 4)
    return ok and compatible and db or nil
end

local function text(value)
    return type(value) == "string" and sharedText.TruncateUtf8Bytes(value, 160) or nil
end

local function npcNames(db, ids)
    local out = {}
    local npc = db and db.Npc
    if not (npc and npc.Get and npc.Exists) then
        return out, "unavailable"
    end
    for _, id in ipairs(ids or {}) do
        if npc.Exists(id) then
            local zones, seen = {}, {}
            for areaId in pairs(npc.Get(id, "spawns") or {}) do
                local zone = C_Map.GetAreaInfo and C_Map.GetAreaInfo(areaId)
                if zone and not seen[zone] and #zones < 4 then
                    seen[zone] = true
                    zones[#zones + 1] = zone
                end
            end
            table.sort(zones)
            out[#out + 1] = {
                id = id,
                name = text(npc.Get(id, "name")),
                subName = text(npc.Get(id, "subName")),
                zones = zones,
            }
        end
    end
    return out, "available"
end

local function questNames(db, ids)
    local out = {}
    local quest = db and db.Quest
    if not (quest and quest.Get and quest.Exists) then
        return out, "unavailable"
    end
    for _, id in ipairs(ids or {}) do
        if quest.Exists(id) then
            out[#out + 1] = {
                id = id,
                name = text(quest.Get(id, "name")),
                requiredLevel = quest.Get(id, "requiredLevel"),
                questLevel = quest.Get(id, "questLevel"),
            }
        end
    end
    return out, "available"
end

local function spellNames(ids)
    local out = {}
    for _, id in ipairs(ids or {}) do
        local info = C_Spell and C_Spell.GetSpellInfo and C_Spell.GetSpellInfo(id)
        out[#out + 1] = { id = id, name = info and text(info.name) or nil }
    end
    return out
end

function ns.Integrations.ReadSourceNames(args)
    local db = args.useQuestie ~= false and questieDB() or nil
    local npcs, npcStatus = npcNames(db, args.npcIds)
    local quests, questStatus = questNames(db, args.questIds)
    local prices, priceError
    if args.itemIds and #args.itemIds > 0 then
        local ok, result = pcall(ns.Integrations.ReadAuctionatorPrices, { itemIds = args.itemIds })
        if ok then
            prices = result.prices
        else
            priceError = tostring(result)
        end
    end
    return {
        npcs = npcs,
        quests = quests,
        spells = spellNames(args.spellIds),
        prices = prices,
        priceStatus = prices and "available" or "unavailable",
        priceError = priceError,
        namesStatus = { npcs = npcStatus, quests = questStatus },
        realm = GetRealmName(),
    }
end
