local _, C = ...
local MAX_AURAS = 64

-- Validate before comparing, indexing or copying values into the JSON payload.
local function accessible(value)
    if issecretvalue and issecretvalue(value) then
        error("Restricted value")
    end
    return value
end
local function text(value, limit)
    value = accessible(value)
    if type(value) == "string" and #value > 0 and #value <= limit then
        return value
    end
end
local function integer(value, min, max)
    value = accessible(value)
    if type(value) == "number" and value >= min and value <= max and value % 1 == 0 then
        return value
    end
end
local function boolean(value)
    value = accessible(value)
    if type(value) == "boolean" then
        return value
    end
end
local function read(fn, validate, ...)
    local args = { ... }
    local ok, value = pcall(function()
        return validate(fn(unpack(args)))
    end)
    if ok then
        return value
    end
end
local function guid(unit)
    return read(UnitGUID, function(v)
        return text(v, 120)
    end, unit)
end
local function roster()
    local raid = read(IsInRaid, boolean)
    if raid == true then
        return "raid"
    end
    local count = read(GetNumSubgroupMembers, function(v)
        return integer(v, 0, 4)
    end)
    if raid == nil or count == nil then
        return "unknown"
    end
    local units = { "player" }
    for i = 1, count do
        units[#units + 1] = "party" .. i
    end
    local identities = {}
    for i, unit in ipairs(units) do
        identities[i] = guid(unit) or false
    end
    return count == 0 and "solo" or "party", units, identities
end
local function matches(member, ids)
    member.matches = {}
    for _, id in ipairs(ids) do
        local entry = { spellId = id }
        for _, aura in ipairs(member.auras) do
            if aura.spellId == id then
                entry.present = true
            end
        end
        if entry.present == nil and member.auraCoverage == "complete" then
            entry.present = false
        end
        member.matches[#member.matches + 1] = entry
    end
end
local function scan(member, ids)
    local wanted = {}
    for _, id in ipairs(ids) do
        wanted[id] = true
    end
    if
        not member.guid
        or member.exists ~= true
        or member.connected ~= true
        or member.visible ~= true
    then
        member.reason = "Unit identity or readability unavailable"
        return
    end
    local ok = pcall(function()
        for i = 1, MAX_AURAS + 1 do
            local aura = accessible(C_UnitAuras.GetAuraDataByIndex(member.unit, i, "HELPFUL"))
            if aura == nil then
                member.auraCoverage = "complete"
                return
            end
            assert(type(aura) == "table", "Invalid aura")
            local id = integer(aura.spellId, 1, 2147483647)
            assert(id, "Unavailable aura spell ID")
            if i > MAX_AURAS then
                member.truncated = true
                member.reason = "Aura limit reached"
                return
            end
            if #ids == 0 or wanted[id] then
                member.auras[#member.auras + 1] = { spellId = id }
            end
        end
    end)
    if not ok then
        member.reason = "Helpful aura API missing, restricted or unreadable"
    end
    if member.auraCoverage ~= "complete" and (#member.auras > 0 or member.truncated) then
        member.auraCoverage = "partial"
    end
end

function C.ReadGroup(args)
    local ids = args.spellIds or {}
    assert(type(ids) == "table" and #ids <= 20, "Invalid spell IDs")
    for _, id in ipairs(ids) do
        assert(integer(id, 1, 2147483647), "Invalid spell ID")
    end
    local mode, units, identities = roster()
    local data = {
        capturedAt = time(),
        source = "WoW addon live API: party units / C_UnitAuras.GetAuraDataByIndex HELPFUL",
        mode = mode,
        coverage = "partial",
        rosterCoverage = mode == "raid" and "unsupported" or "unknown",
        members = {},
        maxMembers = 5,
        maxAurasPerMember = MAX_AURAS,
        fresh = true,
    }
    if not units then
        data.reason = mode == "raid" and "Raid inspection unsupported" or "Roster API unavailable"
        return data
    end
    data.rosterCoverage = "complete"
    data.coverage = "complete"
    for i, unit in ipairs(units) do
        local member = {
            unit = unit,
            guid = identities[i] or nil,
            capturedAt = data.capturedAt,
            auras = {},
            auraCoverage = "unknown",
            truncated = false,
            unknownFields = {},
        }
        local fields = {
            name = function()
                return read(UnitName, function(v)
                    return text(v, 120)
                end, unit)
            end,
            class = function()
                local ok, value = pcall(function()
                    local _, token = UnitClass(unit)
                    return text(token, 32)
                end)
                if ok then
                    return value
                end
            end,
            level = function()
                return read(UnitLevel, function(v)
                    return integer(v, 1, 255)
                end, unit)
            end,
            exists = function()
                return read(UnitExists, boolean, unit)
            end,
            connected = function()
                return read(UnitIsConnected, boolean, unit)
            end,
            visible = function()
                return read(UnitIsVisible, boolean, unit)
            end,
            dead = function()
                return read(UnitIsDeadOrGhost, boolean, unit)
            end,
        }
        for key, get in pairs(fields) do
            member[key] = get()
            if member[key] == nil then
                member.unknownFields[#member.unknownFields + 1] = key
            end
        end
        if not member.guid then
            member.unknownFields[#member.unknownFields + 1] = "guid"
            data.rosterCoverage = "partial"
        end
        scan(member, ids)
        matches(member, ids)
        if member.auraCoverage ~= "complete" or #member.unknownFields > 0 then
            data.coverage = "partial"
        end
        data.members[#data.members + 1] = member
    end
    -- Revalidate the whole roster and readability after enumeration. Never attach an
    -- observation to a token that was replaced (including earlier members).
    local afterMode, afterUnits, afterIdentities = roster()
    local changed = mode ~= afterMode or not afterUnits or #units ~= #afterUnits
    for i, member in ipairs(data.members) do
        if
            not afterIdentities
            or identities[i] ~= afterIdentities[i]
            or member.exists ~= read(UnitExists, boolean, member.unit)
            or member.connected ~= read(UnitIsConnected, boolean, member.unit)
            or member.visible ~= read(UnitIsVisible, boolean, member.unit)
        then
            changed = true
        end
    end
    if changed then
        data.rosterCoverage = "partial"
        data.coverage = "partial"
        data.reason = "Roster or readability changed during inspection; request a fresh read"
        for _, member in ipairs(data.members) do
            member.auras = {}
            member.auraCoverage = "unknown"
            member.reason = data.reason
            matches(member, ids)
        end
    end
    return data
end
