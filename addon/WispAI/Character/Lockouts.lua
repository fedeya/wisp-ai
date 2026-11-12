local _, ns = ...
local MAX_SCAN, MAX_RECORDS, MAX_WIRE = 100, 20, 20000
local ENVELOPE_RESERVE = 4096
local generation, observation = 0, nil

-- Check public readability before comparison, arithmetic, length or coercion.
local function public(value)
    if type(_G.issecretvalue) == "function" then
        local ok, secret = pcall(_G.issecretvalue, value)
        if not ok or secret then
            return false
        end
    end
    if type(_G.canaccessvalue) == "function" then
        local ok, accessible = pcall(_G.canaccessvalue, value)
        if not ok or not accessible then
            return false
        end
    end
    return true
end

local function number(value, maximum)
    if not public(value) then
        return nil
    end
    local ok, valid = pcall(function()
        return type(value) == "number" and value == value and value >= 0 and value <= maximum
    end)
    if ok and valid then
        return value
    end
end

local function text(value, maximum)
    if not public(value) then
        return nil, false
    end
    local ok, result, clipped = pcall(function()
        if type(value) ~= "string" or value == "" then
            return nil, false
        end
        return ns.Shared.Text.TruncateUtf8Bytes(value, maximum)
    end)
    if ok then
        return result, clipped
    end
    return nil, false
end

local function boolean(value)
    if public(value) and type(value) == "boolean" then
        return value
    end
end

local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, value = pcall(fn, ...)
    if ok then
        return value
    end
end

local function scope()
    local guid, guidClipped = text(call(UnitGUID, "player"), 200)
    local session, sessionClipped = text(ns.session, 200)
    if guid and session and not guidClipped and not sessionClipped then
        return guid, session
    end
end

local function clock()
    return number(call(GetTime), 9007199254740991)
end

local function timestamp()
    return number(call(time), 9007199254740991)
end

local events = CreateFrame("Frame")
for _, event in ipairs({ "UPDATE_INSTANCE_INFO", "PLAYER_ENTERING_WORLD", "PLAYER_LOGOUT" }) do
    events:RegisterEvent(event)
end
events:SetScript("OnEvent", function(_, event)
    generation = generation + 1
    observation = nil
    if event == "UPDATE_INSTANCE_INFO" then
        local guid, session = scope()
        local at = clock()
        if guid and session and at then
            observation = { guid = guid, session = session, at = at, observedAt = timestamp() }
        end
    end
end)

-- Conservative escaped JSON upper bound, including keys/punctuation. Numeric
-- values are finite and bounded. Reserve an additional 4 KiB for the RPC wire
-- envelope; do not estimate unescaped native text lengths as serialized bytes.
local function jsonBound(value)
    if type(value) == "string" then
        return 2 + #value * 6
    end
    if type(value) == "number" then
        return 24
    end
    if type(value) == "boolean" then
        return 5
    end
    local bytes = 2
    for key, child in pairs(value) do
        bytes = bytes + (type(key) == "string" and jsonBound(key) + 1 or 0) + jsonBound(child) + 1
    end
    return bytes
end

local function readRow(index)
    local row =
        { index = index, status = "partial", lockStatus = "unknown", resetStatus = "unknown" }
    local ok, name, _, reset, difficulty, locked, extended, _, raid, _, label =
        pcall(GetSavedInstanceInfo, index)
    if not ok then
        return row
    end
    local nameClipped, labelClipped
    row.name, nameClipped = text(name, 160)
    row.difficultyName, labelClipped = text(label, 96)
    row.textTruncated = nameClipped or labelClipped
    row.difficultyId = number(difficulty, 1000000)
    if row.difficultyId and row.difficultyId % 1 ~= 0 then
        row.difficultyId = nil
    end
    row.locked, row.extended, row.isRaid = boolean(locked), boolean(extended), boolean(raid)
    row.resetSeconds = number(reset, 315360000)
    if row.locked == true or row.extended == true then
        row.lockStatus = "active"
    elseif row.locked == false and row.extended == false then
        row.lockStatus = "inactive"
    end
    if row.resetSeconds then
        row.resetStatus = row.resetSeconds > 0 and "upcoming" or "expired"
        local seconds = math.floor(row.resetSeconds)
        row.resetText = string.format(
            "%dd %dh %dm %ds",
            math.floor(seconds / 86400),
            math.floor(seconds / 3600) % 24,
            math.floor(seconds / 60) % 60,
            seconds % 60
        )
        if seconds < 3600 then
            row.resetText = string.format("%dm %ds", math.floor(seconds / 60), seconds % 60)
        end
    else
        row.resetText = "Unknown"
    end
    if
        row.name
        and row.difficultyId
        and row.difficultyName
        and row.locked ~= nil
        and row.extended ~= nil
        and row.isRaid ~= nil
        and row.resetSeconds ~= nil
        and not row.textTruncated
    then
        row.status = "available"
    end
    -- Instance IDs (including BigInteger halves), maps and encounter expansion
    -- are intentionally not read into the result.
    return row
end

local function rank(row)
    if row.lockStatus == "active" and row.resetStatus == "upcoming" then
        return 1
    end
    if row.lockStatus == "inactive" or row.resetStatus == "expired" then
        return 2
    end
    return 3
end

function ns.Character.ReadLockouts(args)
    local result =
        { status = "unavailable", source = "WoW saved-instance cache", capturedAt = timestamp() }
    args = args or {}
    if type(args) ~= "table" then
        result.error = "Invalid lockout arguments"
        return result
    end
    for key in pairs(args) do
        if key ~= "limit" then
            result.error = "Unknown lockout argument"
            return result
        end
    end
    local limit = args.limit == nil and MAX_RECORDS or number(args.limit, MAX_RECORDS)
    if not limit or limit < 1 or limit % 1 ~= 0 then
        result.error = "Lockout limit must be an integer from 1 to 20"
        return result
    end
    local guid, session = scope()
    if not guid then
        observation = nil
        generation = generation + 1
        result.error = "Character/session identity unavailable"
        return result
    end
    if observation and (observation.guid ~= guid or observation.session ~= session) then
        observation = nil
        generation = generation + 1
    end
    local started = generation
    local function unchanged()
        local current, currentSession = scope()
        return current == guid and currentSession == session and started == generation
    end
    local function changed()
        observation = nil
        result.data = nil
        result.status = "unavailable"
        result.error = "Character/session or cache changed during read; explicitly reread"
        return result
    end
    if type(GetNumSavedInstances) ~= "function" or type(GetSavedInstanceInfo) ~= "function" then
        result.error = "Saved-instance cache APIs unavailable"
        return result
    end
    local count = number(call(GetNumSavedInstances), 9007199254740991)
    if not unchanged() then
        return changed()
    end
    if not count or count % 1 ~= 0 then
        result.error = "Cached count unreadable"
        return result
    end
    local cache = { status = "unobserved", generation = started }
    local at = clock()
    if observation and at and at >= observation.at then
        cache.status, cache.observedAt = "update_observed", observation.observedAt
        cache.ageSeconds = at - observation.at
    elseif observation then
        observation = nil
    end
    local rows = {}
    for index = 1, math.min(count, MAX_SCAN) do
        if not unchanged() then
            return changed()
        end
        rows[#rows + 1] = readRow(index)
        if not unchanged() then
            return changed()
        end
    end
    table.sort(rows, function(a, b)
        local ar, br = rank(a), rank(b)
        if ar ~= br then
            return ar < br
        end
        if ar == 1 and a.resetSeconds ~= b.resetSeconds then
            return a.resetSeconds < b.resetSeconds
        end
        return a.index < b.index
    end)
    result.status = "available"
    result.data = {
        records = {},
        cachedCount = count,
        scannedCount = #rows,
        returnedCount = 0,
        truncated = count > math.min(limit, MAX_SCAN),
        textTruncated = false,
        budgetOmitted = false,
        cache = cache,
        wireUpperBoundBytes = 0,
        note = "Cached records only; capture is not server freshness. An observed update is not an eligibility guarantee. Zero or absent records do not prove raids or loot available. No refresh or action performed.",
    }
    for index = 1, math.min(#rows, limit) do
        local row = rows[index]
        table.insert(result.data.records, row)
        if jsonBound(result) + ENVELOPE_RESERVE + 128 > MAX_WIRE then
            table.remove(result.data.records)
            result.data.budgetOmitted, result.data.truncated = true, true
            break
        end
        if row.status ~= "available" then
            result.status = "partial"
        end
        if row.textTruncated then
            result.data.textTruncated = true
        end
    end
    result.data.returnedCount = #result.data.records
    if result.data.truncated then
        result.status = "partial"
    end
    result.data.wireUpperBoundBytes = jsonBound(result) + ENVELOPE_RESERVE
    if not unchanged() then
        return changed()
    end
    return result
end
