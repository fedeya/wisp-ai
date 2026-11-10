local _, ns = ...

local function finite(value)
    return type(value) == "number" and value == value and value > -math.huge and value < math.huge
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
                                finite(x)
                                and finite(y)
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
                                    frameKnown = finite(projectedX)
                                        and finite(projectedY)
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
