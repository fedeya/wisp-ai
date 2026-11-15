local _, ns = ...

local MAX_NODES = 512
local MAX_ORIGINS = 64
local CONTINENT_MAPS = { 1414, 1415 } -- Kalimdor and Eastern Kingdoms in Forever.
local openObservation

local function addNode(observation, name, state, slot, nodeId)
    if type(name) ~= "string" or name == "" then
        return
    end
    name = ns.Shared.Text.TruncateUtf8Bytes(name, 180)
    if state == "CURRENT" then
        observation.origin = name
    elseif state == "REACHABLE" or state == "UNREACHABLE" then
        local cost
        if state == "REACHABLE" and TaxiNodeCost and slot then
            local ok, value = pcall(TaxiNodeCost, slot)
            if ok and ns.Shared.Numbers.IsNonNegativeInteger(value) then
                cost = value
            end
        end
        local destinations = observation.destinations
        destinations[#destinations + 1] =
            { name = name, nodeId = nodeId, reachable = state == "REACHABLE", costCopper = cost }
    end
end

local function readFlightMap()
    local states = Enum and Enum.FlightPathState
    if not (C_TaxiMap and C_TaxiMap.GetAllTaxiNodes and GetTaxiMapID and states) then
        return
    end
    local mapId = GetTaxiMapID()
    if not mapId or mapId <= 0 then
        return
    end
    local nodes = C_TaxiMap.GetAllTaxiNodes(mapId)
    local observation = { destinations = {}, mapTruncated = #nodes > MAX_NODES }
    local types = {
        [states.Current] = "CURRENT",
        [states.Reachable] = "REACHABLE",
        [states.Unreachable] = "UNREACHABLE",
    }
    for index = 1, math.min(#nodes, MAX_NODES) do
        local node = nodes[index]
        if not node.isMapLayerTransition then
            addNode(observation, node.name, types[node.state], node.slotIndex, node.nodeID)
        end
    end
    return observation
end

local function readTaxiMap()
    if not (NumTaxiNodes and TaxiNodeName and TaxiNodeGetType) then
        return
    end
    local count = NumTaxiNodes()
    local observation = { destinations = {}, mapTruncated = count > MAX_NODES }
    for index = 1, math.min(count, MAX_NODES) do
        addNode(observation, TaxiNodeName(index), TaxiNodeGetType(index), index)
    end
    return observation
end

local function observationsForPlayer()
    local guid = UnitGUID("player")
    return guid and ns.db and ns.db.flightPaths and ns.db.flightPaths[guid], guid
end

local function capture()
    local observations, guid = observationsForPlayer()
    if not guid or not ns.db then
        return
    end
    local ok, observation = pcall(readFlightMap)
    if not (ok and observation and observation.origin) then
        ok, observation = pcall(readTaxiMap)
    end
    if not (ok and observation and observation.origin) then
        return
    end
    observation.originMapId = C_Map
        and C_Map.GetBestMapForUnit
        and C_Map.GetBestMapForUnit("player")
    observation.observedAt = time()
    observations = observations or {}
    for index, previous in ipairs(observations) do
        if
            previous.origin == observation.origin
            and previous.originMapId == observation.originMapId
        then
            table.remove(observations, index)
            break
        end
    end
    table.insert(observations, 1, observation)
    if #observations > MAX_ORIGINS then
        table.remove(observations)
    end
    ns.db.flightPaths = ns.db.flightPaths or {}
    ns.db.flightPaths[guid] = observations
    openObservation = observation
end

local events = CreateFrame("Frame")
events:RegisterEvent("TAXIMAP_OPENED")
events:RegisterEvent("TAXIMAP_CLOSED")
events:SetScript("OnEvent", function(_, event)
    openObservation = nil
    if event == "TAXIMAP_OPENED" then
        capture()
    end
end)

local function readWorldMapPoints(origin, destination, limit)
    local factions = Enum and Enum.FlightPathFaction
    if not (C_TaxiMap and C_TaxiMap.GetTaxiNodesForMap and factions and UnitFactionGroup) then
        return
    end
    local faction = factions[UnitFactionGroup("player")]
    if faction == nil then
        return
    end
    local points, matched, available, seen = {}, 0, false, {}
    for _, mapId in ipairs(CONTINENT_MAPS) do
        local ok, nodes = pcall(C_TaxiMap.GetTaxiNodesForMap, mapId)
        if ok and type(nodes) == "table" and #nodes > 0 then
            local candidates, hasUndiscovered = {}, false
            for index = 1, math.min(#nodes, MAX_NODES) do
                local node = nodes[index]
                if
                    type(node) == "table"
                    and (node.faction == faction or node.faction == factions.Neutral)
                    and type(node.nodeID) == "number"
                    and type(node.name) == "string"
                    and node.name ~= ""
                then
                    candidates[#candidates + 1] = node
                    hasUndiscovered = hasUndiscovered or node.isUndiscovered == true
                end
            end
            available = available or #candidates > 0
            for _, node in ipairs(candidates) do
                local name = node.name:lower()
                if
                    not seen[node.nodeID]
                    and (
                        (not origin and not destination)
                        or (origin and name:find(origin, 1, true))
                        or (destination and name:find(destination, 1, true))
                    )
                then
                    seen[node.nodeID] = true
                    matched = matched + 1
                    if #points < limit then
                        -- Forever can report an entire continent as discovered even on new characters.
                        local discovery = "unknown"
                        if node.isUndiscovered == true then
                            discovery = "undiscovered"
                        elseif hasUndiscovered and node.isUndiscovered == false then
                            discovery = "learned"
                        end
                        points[#points + 1] = {
                            name = ns.Shared.Text.TruncateUtf8Bytes(node.name, 180),
                            nodeId = node.nodeID,
                            discovery = discovery,
                        }
                    end
                end
            end
        end
    end
    if available then
        return {
            source = "WoW world map",
            points = points,
            matched = matched,
            truncated = matched > #points,
        }
    end
end

-- Return bounded matches from the latest map seen at each observed origin.
-- The newest observation comes first; mapOpen only applies to the current map.
function ns.Character.ReadFlightPaths(args)
    local observations = observationsForPlayer() or {}
    local origin = args.origin and args.origin:lower()
    local destination = args.destination and args.destination:lower()
    local limit = math.max(1, math.min(40, tonumber(args.limit) or 20))
    local worldMap = readWorldMapPoints(origin, destination, limit)
    assert(
        #observations > 0 or worldMap,
        "Open a flight master's map to record flight paths for this character"
    )
    local maps, matched, returned = {}, 0, 0
    for _, observation in ipairs(observations) do
        if not origin or observation.origin:lower():find(origin, 1, true) then
            local matches = {}
            for _, node in ipairs(observation.destinations) do
                if not destination or node.name:lower():find(destination, 1, true) then
                    matched = matched + 1
                    if returned < limit then
                        matches[#matches + 1] = node
                        returned = returned + 1
                    end
                end
            end
            if #matches > 0 or (not destination and #observation.destinations == 0) then
                maps[#maps + 1] = {
                    origin = observation.origin,
                    originMapId = observation.originMapId,
                    observedAt = observation.observedAt,
                    mapOpen = observation == openObservation,
                    mapTruncated = observation.mapTruncated,
                    destinations = matches,
                }
            end
        end
    end
    return {
        maps = maps,
        worldMap = worldMap,
        observedOrigins = #observations,
        matched = matched,
        truncated = matched > returned,
    }
end
