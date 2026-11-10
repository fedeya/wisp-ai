local _, C = ...
local open
local frame = CreateFrame("Frame")
frame:RegisterEvent("TAXIMAP_OPENED")
frame:RegisterEvent("TAXIMAP_CLOSED")
frame:SetScript("OnEvent", function(_, event)
    open = event == "TAXIMAP_OPENED"
end)

local function read(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, a, b, c = pcall(fn, ...)
    if ok then
        return a, b, c
    end
end
local function public(value)
    return not issecretvalue or not issecretvalue(value)
end
local function number(value)
    return public(value)
        and type(value) == "number"
        and value == value
        and math.abs(value) < math.huge
end
local function integer(value)
    return number(value) and value >= 0 and value % 1 == 0
end
local function text(value)
    if public(value) and type(value) == "string" and #value > 0 then
        local last = math.min(#value, 160)
        while last > 0 do
            local nextByte = value:byte(last + 1)
            if not nextByte or nextByte < 128 or nextByte >= 192 then
                break
            end
            last = last - 1
        end
        return value:sub(1, last)
    end
end
local function section(source, capturedAt)
    return {
        status = "unavailable",
        capturedAt = capturedAt,
        provenance = source,
        freshness = "on_demand",
    }
end
local function cooldown(capturedAt)
    local native = C_Container and C_Container.GetItemCooldown
    local source = "C_Container.GetItemCooldown"
    local boolean = false
    if type(native) ~= "function" then
        native = C_Item and C_Item.GetItemCooldown
        source, boolean = "C_Item.GetItemCooldown", true
    end
    local out = section(source, capturedAt)
    out.state = "unknown"
    local start, duration, enabled = read(native, 6948)
    local now = read(GetTime)
    if not (number(start) and number(duration) and number(now) and public(enabled)) then
        return out
    end
    if start < 0 or duration < 0 or now < 0 or start > now then
        return out
    end
    -- These native APIs deliberately have different enable flag types.
    if (boolean and enabled ~= true) or (not boolean and enabled ~= 1) then
        out.reason = "disabled_or_invalid_enable_flag"
        return out
    end
    local remaining = start + duration - now
    if not number(remaining) then
        return out
    end
    out.status = "available"
    out.remainingSeconds = math.max(0, remaining)
    out.state = out.remainingSeconds == 0 and "ready" or "cooldown"
    out.clock = "GetTime"
    return out
end
local function hearthstone(capturedAt)
    local out = section("C_Item.GetItemCount (bags only)", capturedAt)
    out.itemId = 6948
    out.cooldown = { status = "unavailable", state = "unknown" }
    local count = read(C_Item and C_Item.GetItemCount, 6948, false, false, false, false)
    if not integer(count) then
        return out
    end
    out.status, out.count, out.owned = "available", count, count > 0
    if count > 0 then
        out.cooldown = cooldown(capturedAt)
    else
        out.cooldown = { status = "not_applicable", state = "not_owned" }
    end
    return out
end
local function position(value)
    if not public(value) or (type(value) ~= "table" and type(value) ~= "userdata") then
        return nil
    end
    local x, y
    if type(value.GetXY) == "function" then
        x, y = read(value.GetXY, value)
    else
        x, y = value.x, value.y
    end
    if number(x) and number(y) and x >= 0 and x <= 1 and y >= 0 and y <= 1 then
        return { x = x, y = y }
    end
end
local function shown(window)
    return window and read(window.IsShown, window) == true
end
local function flights(limit, capturedAt)
    local out = section("current open flight master", capturedAt)
    out.coverage = "current_origin_only"
    out.note =
        "Unreachable means not selectable from this origin, not globally locked. No routes or durations inferred."
    if open == false then
        out.reason = "flight_window_closed"
        return out
    end
    local modern = shown(FlightMapFrame)
    if not modern and not shown(TaxiFrame) then
        out.reason = "flight_window_not_observed"
        return out
    end
    local rows, count
    if modern then
        out.provenance = "FlightMapFrame.GetMapID + C_TaxiMap.GetAllTaxiNodes"
        local map = read(FlightMapFrame.GetMapID, FlightMapFrame)
        if not integer(map) or map == 0 then
            out.reason = "active_map_unavailable"
            return out
        end
        out.mapId, out.mapStatus = map, "available"
        rows = read(C_TaxiMap and C_TaxiMap.GetAllTaxiNodes, map)
        if not public(rows) or type(rows) ~= "table" then
            out.reason = "taxi_nodes_unavailable"
            return out
        end
        count = #rows
        local checked = 0
        for key in pairs(rows) do
            if not integer(key) or key < 1 or key > count then
                out.reason = "malformed_taxi_nodes"
                return out
            end
            checked = checked + 1
            if checked > 512 then
                break
            end
        end
    else
        out.provenance = "TaxiFrame + NumTaxiNodes/TaxiNodeGetType/TaxiNodeName/TaxiNodePosition"
        out.mapStatus = "unavailable"
        count = read(NumTaxiNodes)
        if
            not integer(count)
            or type(TaxiNodeGetType) ~= "function"
            or type(TaxiNodeName) ~= "function"
        then
            out.reason = "legacy_taxi_api_unavailable"
            return out
        end
    end
    out.status, out.nodes, out.total = "available", {}, count
    out.scanned, out.truncated = math.min(count, 512), count > limit or count > 512
    out.invalidNodes = 0
    for i = 1, out.scanned do
        local row, state
        if modern then
            row = rows[i]
            if public(row) and type(row) == "table" then
                if public(row.state) then
                    state = ({ [0] = "current", [1] = "reachable", [2] = "unreachable" })[row.state]
                end
            else
                row = nil
            end
        else
            local nativeState = read(TaxiNodeGetType, i)
            if public(nativeState) then
                state = ({
                    CURRENT = "current",
                    REACHABLE = "reachable",
                    UNREACHABLE = "unreachable",
                    DISTANT = "distant",
                })[nativeState]
            end
            local x, y = read(TaxiNodePosition, i)
            row = { name = read(TaxiNodeName, i), slotIndex = i, position = { x = x, y = y } }
        end
        local name = row and text(row.name)
        if
            not name
            or not integer(row.slotIndex)
            or row.slotIndex == 0
            or (modern and (not integer(row.nodeID) or row.nodeID == 0))
        then
            out.invalidNodes = out.invalidNodes + 1
        else
            local node = {
                name = name,
                slotIndex = row.slotIndex,
                state = state or "unknown",
                position = position(row.position),
            }
            if modern then
                node.nodeId = row.nodeID
            end
            if state then
                node.selectable = state == "reachable"
            end
            if modern then
                if not public(row.isMapLayerTransition) then
                    node.selectable = nil
                elseif row.isMapLayerTransition == true then
                    node.mapLayerTransition, node.selectable = true, false
                end
            end
            if state == "current" then
                out.origin = node
            end
            if #out.nodes < limit then
                out.nodes[#out.nodes + 1] = node
            end
        end
    end
    if out.invalidNodes > 0 or count > 512 then
        out.status = "partial"
    end
    out.originStatus = out.origin and "available" or "unavailable"
    return out
end
function C.InspectTravel(args)
    local capturedAt = read(time)
    if not number(capturedAt) then
        capturedAt = nil
    end
    local limit = args.limit or 50
    assert(integer(limit) and limit >= 1 and limit <= 100, "Travel limit must be 1–100")
    local function capture(source, fn)
        local ok, result = pcall(fn)
        if ok then
            return result
        end
        local out = section(source, capturedAt)
        out.reason = "restricted_or_malformed_reading"
        return out
    end
    return {
        hearthstone = capture("hearthstone", function()
            return hearthstone(capturedAt)
        end),
        bind = capture("GetBindLocation", function()
            local out = section("GetBindLocation", capturedAt)
            out.name = text(read(GetBindLocation))
            out.status = out.name and "available" or "unavailable"
            out.note = "Bind name only; no verified map ID or coordinates."
            return out
        end),
        flights = capture("current open flight master", function()
            return flights(limit, capturedAt)
        end),
    }
end
