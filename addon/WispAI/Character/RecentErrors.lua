local _, ns = ...
local records, enabled, started, identity = {}, false, nil, nil
local omitted, expired, evicted, clipped, sequence = 0, 0, 0, 0, 0
local timer
local events = CreateFrame("Frame")
local function notify()
    if ns.UI.RecentErrors and ns.UI.RecentErrors.Refresh then
        ns.UI.RecentErrors.Refresh()
    end
end
local function readable(value)
    local isSecret = _G.issecretvalue
    return not (isSecret and isSecret(value))
end
local function expire()
    local now = GetTime()
    for i = #records, 1, -1 do
        if now - records[i].latest >= 120 then
            table.remove(records, i)
            expired = expired + 1
        end
    end
end
local function schedule()
    if timer then
        timer:Cancel()
        timer = nil
    end
    if #records == 0 then
        return
    end
    local oldest = GetTime()
    for _, record in ipairs(records) do
        oldest = math.min(oldest, record.latest)
    end
    timer = C_Timer.NewTimer(math.max(0.01, oldest + 120 - GetTime()), function()
        timer = nil
        expire()
        notify()
        schedule()
    end)
end

-- Local opt-in only; neither preference nor observations are SavedVariables.
function ns.RecentErrors.SetEnabled(value)
    enabled = value == true
    records, started = {}, enabled and GetTime() or nil
    omitted, expired, evicted, clipped = 0, 0, 0, 0
    local guid = UnitGUID("player")
    identity = readable(guid) and guid or nil
    if enabled then
        events:RegisterEvent("UI_ERROR_MESSAGE")
    else
        events:UnregisterEvent("UI_ERROR_MESSAGE")
    end
    schedule()
    notify()
end

-- Copy out readable bounded fields, oldest to newest latest delivery (arrival
-- order breaks equal-time ties). Counts describe event deliveries, not actions.
function ns.RecentErrors.Read()
    expire()
    local now, result = GetTime(), {}
    for _, record in ipairs(records) do
        result[#result + 1] = {
            id = record.id,
            errorType = record.errorType,
            text = record.text,
            firstAge = math.max(0, now - record.first),
            latestAge = math.max(0, now - record.latest),
            count = record.count,
            truncated = record.truncated,
        }
    end
    return {
        enabled = enabled,
        captureAge = started and math.max(0, now - started) or nil,
        windowSeconds = 120,
        capacity = 30,
        records = result,
        omitted = omitted,
        expired = expired,
        evicted = evicted,
        clipped = clipped,
        wireOmitted = 0,
        coverage = "Readable UI_ERROR_MESSAGE deliveries only; not proof of displayed red text or its cause. Disabled, empty or restricted capture does not prove no errors occurred.",
    }
end

-- Budget the complete Inspect result, including shared metadata and JSON escaping.
function ns.RecentErrors.BoundResult(result)
    if not readable(result.character) or type(result.character) ~= "string" then
        result.character = nil
        result.characterOmitted = true
    else
        result.character, result.characterTruncated =
            ns.Shared.Text.TruncateUtf8Bytes(result.character, 120)
    end
    while #C_EncodingUtil.SerializeJSON(result) > 24576 and #result.data.records > 0 do
        table.remove(result.data.records, 1)
        result.data.wireOmitted = result.data.wireOmitted + 1
    end
    return result
end

events:RegisterEvent("PLAYER_LOGOUT")
events:RegisterEvent("PLAYER_ENTERING_WORLD")
events:SetScript("OnEvent", function(_, event, errorType, message)
    if event == "PLAYER_LOGOUT" then
        ns.RecentErrors.SetEnabled(false)
        return
    elseif event == "PLAYER_ENTERING_WORLD" then
        local guid = UnitGUID("player")
        if not readable(guid) or guid ~= identity then
            ns.RecentErrors.SetEnabled(false)
        end
        return
    end
    if event ~= "UI_ERROR_MESSAGE" or not enabled then
        return
    end
    -- Never coerce, compare, index or serialize a secret field, including the type.
    if not readable(errorType) or not readable(message) then
        omitted = omitted + 1
        notify()
        return
    end
    if
        not ns.Shared.Numbers.IsFinite(errorType)
        or errorType < 1
        or errorType > 2147483647
        or errorType % 1 ~= 0
        or type(message) ~= "string"
        or message == ""
    then
        omitted = omitted + 1
        notify()
        return
    end
    expire()
    local text, truncated = ns.Shared.Text.TruncateUtf8Bytes(message, 512)
    if truncated then
        clipped = clipped + 1
    end
    local now = GetTime()
    -- Clipped messages cannot be proven equal: never coalesce their prefixes.
    for index, record in ipairs(records) do
        if
            not truncated
            and not record.truncated
            and record.errorType == errorType
            and record.text == text
        then
            record.latest, record.count = now, math.min(2147483647, record.count + 1)
            -- Keep stable identity/first age, but capacity and wire eviction must
            -- remove the least recently delivered record, not the oldest ID.
            table.remove(records, index)
            records[#records + 1] = record
            schedule()
            notify()
            return
        end
    end
    if #records >= 30 then
        table.remove(records, 1)
        evicted = evicted + 1
    end
    sequence = sequence + 1
    records[#records + 1] = {
        id = sequence,
        errorType = errorType,
        text = text,
        truncated = truncated,
        first = now,
        latest = now,
        count = 1,
    }
    schedule()
    notify()
end)
