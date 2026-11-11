-- QuestieDB Forever readiness and read-only quest/location adapters.
local _, ns = ...
local numbers = ns.Shared.Numbers
local sharedText = ns.Shared.Text

local function reads(entity)
    return entity and type(entity.Get) == "function" and type(entity.Exists) == "function" or false
end

function ns.Integrations._QuestieReport()
    local db = LibQuestieDB
    local status, trainers, services, npcs, quests, objects =
        "missing", false, false, false, false, false
    if db then
        status = "incompatible"
        local ok, compatible = pcall(function()
            return db.flavor
                and db.flavor.expansion == "Forever"
                and db.RequireContract
                and db.RequireContract(4)
        end)
        if ok and compatible then
            npcs, quests, objects = reads(db.Npc), reads(db.Quest), reads(db.Object)
            status = (npcs or quests or objects) and "partial" or "incompatible"
            if Questie and Questie.IsForever and QuestieLoader and QuestieLoader.ImportModule then
                local loaded, townsfolk =
                    pcall(QuestieLoader.ImportModule, QuestieLoader, "Townsfolk")
                if loaded and townsfolk then
                    trainers = type(townsfolk.GetClassTrainers) == "function"
                    services = type(townsfolk.townsfolk) == "table"
                end
            end
            if npcs and quests and objects and trainers and services then
                status = "ready"
            end
        end
    end
    return {
        status = status,
        version = db and ns.Integrations._AddonVersion("QuestieDB") or nil,
        npcs = npcs,
        quests = quests,
        objects = objects,
        trainers = trainers,
        services = services,
    }
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
            return sharedText.TruncateUtf8Bytes(value, 400)
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
                if not numbers.IsNonNegativeInteger(key) or key < 1 then
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
            if numbers.IsNonNegativeInteger(candidate) and candidate > 0 then
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
                    name = type(name) == "string" and sharedText.TruncateUtf8Bytes(name, 160)
                        or nil,
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

local function findLocations(entityName, args)
    local db = LibQuestieDB
    assert(
        db and db.flavor and db.flavor.expansion == "Forever",
        "QuestieDB Forever is not loaded; another game version cannot be used"
    )
    assert(
        db.RequireContract and db.RequireContract(4),
        "A compatible QuestieDB contract is required"
    )
    local npc = db[entityName]
    assert(npc and npc.Get and npc.Exists, "QuestieDB spawn reads are unavailable")
    local zoneDB, townsfolk
    if QuestieLoader and QuestieLoader.ImportModule then
        local ok, value = pcall(QuestieLoader.ImportModule, QuestieLoader, "ZoneDB")
        if ok then
            zoneDB = value
        end
        ok, value = pcall(QuestieLoader.ImportModule, QuestieLoader, "Townsfolk")
        if ok then
            townsfolk = value
        end
    end
    local mapId = args.mapId or C_Map.GetBestMapForUnit("player")
    local map = mapId and C_Map.GetMapInfo(mapId)
    assert(map, "Resolve a native UI map ID with inspect_map first")
    local ids
    if args.mode == "class_trainers" then
        assert(
            Questie and Questie.IsForever and townsfolk and townsfolk.GetClassTrainers,
            "Questie's Forever class-trainer index is unavailable"
        )
        local _, class = UnitClass("player")
        ids = townsfolk.GetClassTrainers()[args.class or class] or {}
    elseif args.mode == "services" then
        assert(
            Questie and Questie.IsForever and townsfolk and townsfolk.townsfolk,
            "Questie's Forever service index is unavailable"
        )
        assert(
            args.service and type(townsfolk.townsfolk[args.service]) == "table",
            "The requested service is unavailable in the installed Questie index; this does not prove it is absent from Forever"
        )
        ids = townsfolk.townsfolk[args.service]
    elseif args.npcId or args.objectId then
        ids = { args.npcId or args.objectId }
    elseif args.name and npc.IdsByName then
        ids = npc.IdsByName(args.name) or {}
    else
        error("Provide an exact localized entity name or a verified entity ID")
    end
    local limit = math.min(10, math.max(1, args.limit or 5))
    local locations, skippedFrames, unmatchedMaps = {}, 0, 0
    local faction = UnitFactionGroup("player") == "Horde" and "H" or "A"
    for _, id in ipairs(ids) do
        if npc.Exists(id) then
            local friendly = entityName == "Npc" and npc.Get(id, "friendlyToFaction") or nil
            if not friendly or friendly:find(faction, 1, true) then
                local name = npc.Get(id, "name")
                local subName = entityName == "Npc" and npc.Get(id, "subName") or nil
                local spawns = npc.Get(id, "spawns") or {}
                for areaId, points in pairs(spawns) do
                    local nativeId
                    if zoneDB and zoneDB.GetUiMapIdByAreaId and zoneDB.GetAreaIdByUiMapId then
                        local candidate = zoneDB:GetUiMapIdByAreaId(areaId)
                        if
                            candidate
                            and C_Map.GetMapInfo(candidate)
                            and zoneDB:GetAreaIdByUiMapId(candidate) == areaId
                        then
                            nativeId = candidate
                        end
                    elseif C_Map.GetAreaInfo and C_Map.GetAreaInfo(areaId) == map.name then
                        nativeId = mapId
                    end
                    if nativeId == mapId then
                        for _, point in ipairs(points) do
                            local x, y = point[1], point[2]
                            if
                                numbers.IsFinite(x)
                                and numbers.IsFinite(y)
                                and x >= 0
                                and x <= 100
                                and y >= 0
                                and y <= 100
                            then
                                local frameKnown = false
                                if db.EraToForever then
                                    local projectedX, projectedY = db.EraToForever(areaId, x, y)
                                    -- A non-identity projection needs per-record frame provenance.
                                    -- Never guess whether a composed point has already been projected.
                                    frameKnown = numbers.IsFinite(projectedX)
                                        and numbers.IsFinite(projectedY)
                                        and math.abs(projectedX - x) < 0.01
                                        and math.abs(projectedY - y) < 0.01
                                end
                                if frameKnown then
                                    locations[#locations + 1] = {
                                        npcId = entityName == "Npc" and id or nil,
                                        objectId = entityName == "Object" and id or nil,
                                        name = name,
                                        subName = subName,
                                        mapId = mapId,
                                        zone = map.name,
                                        areaId = areaId,
                                        x = x,
                                        y = y,
                                        phase = point[3],
                                        provenance = db.GetProvenance
                                            and db.GetProvenance(entityName, id, "spawns"),
                                        reference = {
                                            kind = "map",
                                            mapId = mapId,
                                            x = x,
                                            y = y,
                                            label = name or tostring(id),
                                            source = "QuestieDB Forever",
                                        },
                                    }
                                else
                                    skippedFrames = skippedFrames + 1
                                end
                            end
                        end
                    elseif not nativeId then
                        unmatchedMaps = unmatchedMaps + 1
                    end
                end
            end
        end
    end
    table.sort(locations, function(a, b)
        local aid, bid = a.npcId or a.objectId, b.npcId or b.objectId
        if aid ~= bid then
            return aid < bid
        end
        if a.x ~= b.x then
            return a.x < b.x
        end
        return a.y < b.y
    end)
    local total = #locations
    while #locations > limit do
        table.remove(locations)
    end
    return {
        status = total > 0 and "available" or "no_matches",
        version = "forever",
        source = {
            name = "QuestieDB Forever",
            url = "https://github.com/Questie/QuestieDB",
            contract = db.contractVersion,
        },
        mapId = mapId,
        zone = map.name,
        locations = locations,
        total = total,
        truncated = total > limit,
        skippedUnverifiedFrames = skippedFrames,
        unmappedAreas = unmatchedMaps,
        note = "Database spawn positions, not live sightings or guaranteed active phases. Coordinates are percentages on the verified native map. Missing coverage is unknown, not absence. No waypoint was placed.",
    }
end

function ns.Integrations.FindNPCLocations(args)
    return findLocations("Npc", args)
end
function ns.Integrations.FindObjectLocations(args)
    return findLocations("Object", args)
end
