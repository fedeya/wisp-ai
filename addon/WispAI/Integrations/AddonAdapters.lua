-- Read-only adapters use public addon APIs and never edit another addon's data or code.
local _, ns = ...
local function integer(value)
    return type(value) == "number"
        and value == value
        and value >= 0
        and value < math.huge
        and value % 1 == 0
end
local function trimText(value, limit)
    local last = math.min(#value, limit)
    while last > 0 do
        local nextByte = value:byte(last + 1)
        if not nextByte or nextByte < 128 or nextByte >= 192 then
            break
        end
        last = last - 1
    end
    return value:sub(1, last)
end
local function questDB()
    local db = LibQuestieDB
    assert(db and db.flavor and db.flavor.expansion == "Forever", "QuestieDB Forever is required")
    assert(db.RequireContract and db.RequireContract(4), "QuestieDB contract 4 is required")
    assert(db.Quest and db.Quest.Get and db.Quest.Exists, "QuestieDB quest reads are unavailable")
    return db, db.Quest
end
local function questState(id)
    local complete, active
    if C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted then
        complete = C_QuestLog.IsQuestFlaggedCompleted(id)
    end
    if C_QuestLog and C_QuestLog.IsOnQuest then
        active = C_QuestLog.IsOnQuest(id)
    end
    return {
        completed = complete,
        active = active,
        completionKnown = type(complete) == "boolean",
        activeKnown = type(active) == "boolean",
    }
end
function ns.Integrations.ReadQuestieQuest(args)
    local db, quest = questDB()
    if not quest.Exists(args.questId) then
        return {
            status = "unknown",
            questId = args.questId,
            version = "forever",
            note = "No record in this provider; not proof the quest does not exist.",
        }
    end
    local budget, truncated = 120, false
    local function copy(value, depth)
        if budget <= 0 then
            truncated = true
            return nil
        end
        budget = budget - 1
        if type(value) == "string" then
            if #value > 400 then
                truncated = true
            end
            return trimText(value, 400)
        elseif type(value) == "number" or type(value) == "boolean" then
            return value
        elseif type(value) == "table" and depth < 4 then
            local out, count = {}, 0
            for key, child in pairs(value) do
                count = count + 1
                if count > 40 then
                    truncated = true
                    break
                end
                if type(key) == "number" or type(key) == "string" then
                    out[key] = copy(child, depth + 1)
                end
            end
            -- Questie tuples can omit positional groups (for example an item
            -- objective at index 3 without creature/object groups). WoW JSON
            -- rejects sparse/mixed tables. Keep dense arrays as arrays, and
            -- preserve sparse positions as explicit JSON object keys.
            local size, highest, array = 0, 0, true
            for key in pairs(out) do
                size = size + 1
                if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
                    array = false
                else
                    highest = math.max(highest, key)
                end
            end
            if not array or highest ~= size then
                local object = {}
                for key, child in pairs(out) do
                    object[tostring(key)] = child
                end
                return object
            end
            return out
        elseif value ~= nil then
            truncated = true
        end
    end
    local fields = {
        "name",
        "requiredLevel",
        "questLevel",
        "requiredMaxLevel",
        "requiredRaces",
        "requiredClasses",
        "startedBy",
        "finishedBy",
        "objectivesText",
        "objectives",
        "sourceItemId",
        "preQuestGroup",
        "preQuestSingle",
        "nextQuestInChain",
        "childQuests",
        "parentQuest",
        "exclusiveTo",
        "inGroupWith",
        "requiredSkill",
        "requiredMinRep",
        "requiredMaxRep",
        "requiredSourceItems",
        "availableUntilCompleted",
        "availableStartingWith",
        "disabledByQuest",
        "requiredSpell",
        "requiredSpecialization",
        "breadcrumbForQuestId",
        "breadcrumbs",
    }
    local data, unknown = {}, {}
    for _, key in ipairs(fields) do
        local value = quest.Get(args.questId, key)
        if value == nil then
            unknown[#unknown + 1] = key
        else
            data[key] = copy(value, 0)
        end
    end
    return {
        status = "available",
        questId = args.questId,
        version = "forever",
        source = "QuestieDB Forever",
        data = data,
        unknownFields = unknown,
        truncated = truncated,
        liveState = questState(args.questId),
        reference = { kind = "quest", id = args.questId, label = data.name },
        provenance = db.GetProvenance and db.GetProvenance("Quest", args.questId, "name"),
        note = "Static quest requirements and relations are not an eligibility check. Nil fields mean unknown, not no requirement. preQuestGroup requires all; preQuestSingle contains alternatives. Objectives retain QuestieDB canonical tuples.",
    }
end
function ns.Integrations.ReadQuestieChain(args)
    local _, quest = questDB()
    local pending, seen, nodes, missing = { { id = args.questId, depth = 0 } }, {}, {}, {}
    local cursor, truncated = 1, false
    local limit, maxDepth = math.min(args.limit or 15, 30), math.min(args.maxDepth or 2, 4)
    local function relations(id, key)
        local value, ids = quest.Get(id, key), {}
        if type(value) == "number" then
            value = { value }
        end
        for _, candidate in ipairs(type(value) == "table" and value or {}) do
            if #ids >= 40 then
                truncated = true
                break
            end
            if integer(candidate) and candidate > 0 then
                ids[#ids + 1] = candidate
            end
        end
        return ids, value ~= nil
    end
    while cursor <= #pending and #nodes + #missing < limit do
        local entry = pending[cursor]
        cursor = cursor + 1
        if not seen[entry.id] then
            seen[entry.id] = true
            if not quest.Exists(entry.id) then
                missing[#missing + 1] = entry.id
            else
                local links, known = {}, {}
                for _, key in ipairs({
                    "preQuestGroup",
                    "preQuestSingle",
                    "parentQuest",
                    "childQuests",
                    "nextQuestInChain",
                    "exclusiveTo",
                }) do
                    links[key], known[key] = relations(entry.id, key)
                end
                local name = quest.Get(entry.id, "name")
                nodes[#nodes + 1] = {
                    id = entry.id,
                    name = type(name) == "string" and trimText(name, 160) or nil,
                    requiredLevel = quest.Get(entry.id, "requiredLevel"),
                    relations = links,
                    knownRelations = known,
                    liveState = questState(entry.id),
                    depth = entry.depth,
                    reference = { kind = "quest", id = entry.id, label = name },
                }
                local keys = {}
                if args.direction ~= "followups" then
                    keys = { "preQuestGroup", "preQuestSingle", "parentQuest" }
                end
                if args.direction ~= "prerequisites" then
                    keys[#keys + 1] = "childQuests"
                    keys[#keys + 1] = "nextQuestInChain"
                end
                for _, key in ipairs(keys) do
                    for _, id in ipairs(links[key]) do
                        if not seen[id] then
                            if entry.depth >= maxDepth or #pending >= limit * 4 then
                                truncated = true
                            else
                                pending[#pending + 1] = { id = id, depth = entry.depth + 1 }
                            end
                        end
                    end
                end
            end
        end
    end
    if cursor <= #pending then
        truncated = true
    end
    return {
        status = #nodes > 0 and "available" or "unknown",
        version = "forever",
        source = "QuestieDB Forever",
        rootQuestId = args.questId,
        nodes = nodes,
        missingQuestIds = missing,
        truncated = truncated,
        maxDepth = maxDepth,
        note = "Database relations, not a recommended route or proof of eligibility. Group prerequisites require all; single prerequisites are alternatives. Unknown relation fields and missing records remain unknown.",
    }
end
function ns.Integrations.FindStoredItem(args)
    local api = Syndicator and Syndicator.API
    assert(
        api and api.IsReady and api.IsReady() and api.GetInventoryInfoByItemID,
        "Syndicator inventory API is not ready"
    )
    local data = api.GetInventoryInfoByItemID(args.itemId, true, true)
    assert(type(data) == "table", "Syndicator inventory data is unavailable")
    local matches, total = {}, 0
    for _, row in ipairs(data.characters or {}) do
        local counts, count = {}, 0
        for _, key in ipairs({ "bags", "bank", "mail", "equipped", "void", "auctions" }) do
            if integer(row[key]) then
                counts[key] = row[key]
                count = count + row[key]
            end
        end
        if count > 0 then
            total = total + count
            matches[#matches + 1] = {
                character = row.character,
                realm = row.realmNormalized,
                counts = counts,
                total = count,
            }
        end
    end
    if args.includeGuild then
        for _, row in ipairs(data.guilds or {}) do
            if integer(row.bank) and row.bank > 0 then
                total = total + row.bank
                matches[#matches + 1] = {
                    guild = row.guild,
                    realm = row.realmNormalized,
                    counts = { bank = row.bank },
                    total = row.bank,
                }
            end
        end
    end
    table.sort(matches, function(a, b)
        return (tostring(a.character or a.guild) .. "-" .. tostring(a.realm))
            < (tostring(b.character or b.guild) .. "-" .. tostring(b.realm))
    end)
    local owners = #matches
    while #matches > math.min(args.limit or 20, 40) do
        table.remove(matches)
    end
    return {
        status = "available",
        source = "Syndicator public API",
        version = "forever",
        itemId = args.itemId,
        matches = matches,
        totalCached = total,
        owners = owners,
        truncated = owners > #matches,
        cached = true,
        cacheAge = "unknown",
        scope = "visible characters on the current connected realm and faction",
        includesGuild = args.includeGuild == true,
        note = "Counts are cached observations; storage can be inaccessible or stale. Empty matches mean no cached match in this scope, not absence. Current bags should be verified through the live game API.",
    }
end
function ns.Integrations.ReadAuctionatorPrices(args)
    local api = Auctionator and Auctionator.API and Auctionator.API.v1
    assert(api and api.GetAuctionPriceByItemID, "Auctionator price API is unavailable")
    local prices, seen = {}, {}
    for _, id in ipairs(args.itemIds or {}) do
        if not seen[id] then
            seen[id] = true
            local price = api.GetAuctionPriceByItemID("WispAI", id)
            local age = api.GetAuctionAgeByItemID and api.GetAuctionAgeByItemID("WispAI", id)
            local known = integer(price) and price > 0
            prices[#prices + 1] = {
                itemId = id,
                status = known and "available" or "unknown",
                unitPriceCopper = known and price or nil,
                ageDays = known and integer(age) and age or nil,
                ageKnown = known and integer(age) or false,
            }
        end
    end
    return {
        status = "available",
        source = "Auctionator public API",
        version = "forever",
        realm = GetRealmName(),
        faction = UnitFactionGroup("player"),
        prices = prices,
        cached = true,
        note = "Last-seen unit prices in copper, not live listings or sale guarantees. Age is whole days, not an exact timestamp. Missing prices/ages are unknown. No search, scan, purchase or posting was performed.",
    }
end
function ns.Integrations.InspectIntegration(inspection)
    local readers = {
        questie_quest = ns.Integrations.ReadQuestieQuest,
        questie_chain = ns.Integrations.ReadQuestieChain,
        object_locations = ns.Integrations.FindObjectLocations,
        stored_item = ns.Integrations.FindStoredItem,
        item_prices = ns.Integrations.ReadAuctionatorPrices,
    }
    local reader = readers[inspection.kind]
    if not reader then
        return nil
    end
    local ok, data = pcall(reader, inspection.args or {})
    return {
        status = ok and "available" or "unavailable",
        data = ok and data or nil,
        error = not ok and tostring(data) or nil,
        capturedAt = time(),
    }
end
