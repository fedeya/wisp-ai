local _, ns = ...

-- Combat involving the player, kept in memory since login or reload.
-- The ring holds the last CAPACITY rows of at most MAX_AGE seconds; each death
-- freezes the rows of its last RECAP_SECONDS into a recap.
local CAPACITY, MAX_AGE = 300, 120
local RECAP_SECONDS, RECAP_EVENTS, MAX_DEATHS = 20, 60, 5
local TOP_SOURCES = 8
local ring, written = {}, 0
local deaths = {}
local playerGUID

local AURA_EVENTS = {
    SPELL_AURA_APPLIED = true,
    SPELL_AURA_APPLIED_DOSE = true,
    SPELL_AURA_REMOVED = true,
}

local function readable(value)
    return value ~= nil and not (issecretvalue and issecretvalue(value))
end

local function number(value)
    return readable(value) and type(value) == "number" and value or nil
end

local function name(value)
    if not readable(value) or type(value) ~= "string" or value == "" then
        return nil
    end
    return (value:gsub("[%c|]", " "):sub(1, 80))
end

local function positive(value)
    value = number(value)
    return value and value > 0 and value or nil
end

local function kindOf(subevent)
    if subevent:find("_DAMAGE$") or subevent == "DAMAGE_SHIELD" or subevent == "DAMAGE_SPLIT" then
        return "damage"
    elseif subevent:find("_MISSED$") then
        return "missed"
    elseif subevent:find("_HEAL$") then
        return "heal"
    elseif AURA_EVENTS[subevent] then
        return "aura"
    elseif subevent == "SPELL_INTERRUPT" then
        return "interrupt"
    elseif subevent == "SPELL_INSTAKILL" then
        return "instakill"
    elseif subevent == "SPELL_CAST_SUCCESS" then
        return "cast"
    end
    return nil
end

-- Fills the suffix fields of a combat log row; `...` starts after the prefix.
local function fillSuffix(row, kind, ...)
    if kind == "damage" then
        local amount, overkill, _, resisted, blocked, absorbed, critical, glancing, crushing = ...
        row.amount = number(amount)
        row.overkill = positive(overkill)
        row.resisted = positive(resisted)
        row.blocked = positive(blocked)
        row.absorbed = positive(absorbed)
        row.critical = critical == true or nil
        row.glancing = glancing == true or nil
        row.crushing = crushing == true or nil
    elseif kind == "missed" then
        local missType, _, amountMissed = ...
        row.missType = name(missType)
        row.amount = positive(amountMissed)
    elseif kind == "heal" then
        local amount, overhealing, absorbed, critical = ...
        row.amount = number(amount)
        row.overhealing = positive(overhealing)
        row.absorbed = positive(absorbed)
        row.critical = critical == true or nil
    elseif kind == "aura" then
        local auraType, stacks = ...
        row.auraType = name(auraType)
        row.stacks = positive(stacks)
    elseif kind == "interrupt" then
        local _, interruptedSpell = ...
        row.interruptedSpell = name(interruptedSpell)
    end
end

local function playerHealth()
    local health = UnitHealth and number(UnitHealth("player"))
    local maximum = UnitHealthMax and number(UnitHealthMax("player"))
    return health, maximum
end

local function push(row)
    written = written + 1
    ring[(written - 1) % CAPACITY + 1] = row
end

-- Rows at or after `cutoff`, oldest first.
local function since(cutoff)
    local out = {}
    for offset = 0, math.min(written, CAPACITY) - 1 do
        local row = ring[(written - 1 - offset) % CAPACITY + 1]
        if row.at < cutoff then
            break
        end
        out[#out + 1] = row
    end
    for i = 1, math.floor(#out / 2) do
        out[i], out[#out + 1 - i] = out[#out + 1 - i], out[i]
    end
    return out
end

local function record(timestamp, subevent, _, srcGUID, srcName, _, _, dstGUID, dstName, _, _, ...)
    if not readable(subevent) or type(subevent) ~= "string" then
        return
    end
    playerGUID = playerGUID or UnitGUID("player")
    local incoming = playerGUID ~= nil and dstGUID == playerGUID
    local outgoing = playerGUID ~= nil and srcGUID == playerGUID
    if not incoming and not (outgoing and subevent == "SPELL_CAST_SUCCESS") then
        return
    end
    local kind = kindOf(subevent)
    if not kind or (kind == "cast" and not outgoing) then
        return
    end
    local row = {
        at = number(timestamp) or time(),
        event = subevent,
        kind = kind,
        source = name(srcName),
        target = not incoming and name(dstName) or nil,
    }
    if subevent:sub(1, 6) == "SWING_" then
        row.spell = "Melee"
        fillSuffix(row, kind, ...)
    elseif subevent:sub(1, 14) == "ENVIRONMENTAL_" then
        local environment = ...
        row.environment = name(environment)
        row.spell = row.environment
        fillSuffix(row, kind, select(2, ...))
    else
        local spellId, spellName = ...
        row.spellId = positive(spellId)
        row.spell = name(spellName)
        fillSuffix(row, kind, select(4, ...))
    end
    if kind == "aura" and row.auraType ~= "DEBUFF" then
        return
    end
    row.health = playerHealth()
    push(row)
end

local function copy(row, diedAt)
    local out = {}
    for key, value in pairs(row) do
        out[key] = value
    end
    out.secondsBeforeDeath = math.floor((diedAt - row.at) * 10 + 0.5) / 10
    return out
end

local function ranked(totals, limit)
    local out = {}
    for _, entry in pairs(totals) do
        out[#out + 1] = entry
    end
    table.sort(out, function(a, b)
        return a.amount > b.amount
    end)
    for i = #out, limit + 1, -1 do
        out[i] = nil
    end
    return out
end

local function recordDeath(diedAt)
    local rows = since(diedAt - RECAP_SECONDS)
    local _, healthMax = playerHealth()
    local damage, healing, damageTotal, healingTotal = {}, {}, 0, 0
    local killingBlow, highHealthAt
    for _, row in ipairs(rows) do
        local amount = row.amount or 0
        if row.kind == "damage" or row.kind == "instakill" then
            local key = (row.source or "?") .. "\0" .. (row.spell or "?")
            local entry = damage[key]
                or { source = row.source, ability = row.spell, amount = 0, hits = 0 }
            entry.amount = entry.amount + amount
            entry.hits = entry.hits + 1
            entry.critical = (entry.critical or 0) + (row.critical and 1 or 0)
            damage[key] = entry
            damageTotal = damageTotal + amount
            if not killingBlow or row.overkill or not killingBlow.overkill then
                killingBlow = row
            end
        elseif row.kind == "heal" then
            local effective = math.max(0, amount - (row.overhealing or 0))
            local entry = healing[row.source or "?"]
                or { source = row.source, amount = 0, overhealing = 0, heals = 0 }
            entry.amount = entry.amount + effective
            entry.overhealing = entry.overhealing + (row.overhealing or 0)
            entry.heals = entry.heals + 1
            healing[row.source or "?"] = entry
            healingTotal = healingTotal + effective
        end
        if row.health and healthMax and healthMax > 0 and row.health >= healthMax * 0.9 then
            highHealthAt = row.at
        end
    end
    local events = {}
    for i = math.max(1, #rows - RECAP_EVENTS + 1), #rows do
        events[#events + 1] = copy(rows[i], diedAt)
    end
    table.insert(deaths, 1, {
        diedAt = diedAt,
        zone = GetRealZoneText and name(GetRealZoneText()) or nil,
        subzone = GetSubZoneText and name(GetSubZoneText()) or nil,
        level = UnitLevel and number(UnitLevel("player")) or nil,
        healthMax = healthMax,
        windowSeconds = RECAP_SECONDS,
        killingBlow = killingBlow and copy(killingBlow, diedAt) or nil,
        damageTaken = damageTotal,
        healingReceived = healingTotal,
        damageBySource = ranked(damage, TOP_SOURCES),
        healingBySource = ranked(healing, TOP_SOURCES),
        secondsFromHighHealth = highHealthAt
                and math.floor((diedAt - highHealthAt) * 10 + 0.5) / 10
            or nil,
        events = events,
    })
    deaths[MAX_DEATHS + 1] = nil
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED")
frame:RegisterEvent("PLAYER_DEAD")
frame:SetScript("OnEvent", function(_, event, ...)
    if event == "PLAYER_DEAD" then
        -- The killing blow can be logged just after PLAYER_DEAD; build the recap a moment later.
        local diedAt = time()
        if C_Timer and C_Timer.After then
            C_Timer.After(0.5, function()
                recordDeath(diedAt)
            end)
        else
            recordDeath(diedAt)
        end
    elseif CombatLogGetCurrentEventInfo then
        record(CombatLogGetCurrentEventInfo())
    else
        record(...)
    end
end)

function ns.CombatLog.Clear()
    ring, written, deaths = {}, 0, {}
end

local function trimEvents(events, limit)
    local out = {}
    for i = math.max(1, #events - limit + 1), #events do
        out[#out + 1] = events[i]
    end
    return out
end

---Reads the death recaps (`view = "deaths"`) or the rolling buffer (`view = "recent"`).
---@param args { view?: string, deaths?: number, lastSeconds?: number, eventLimit?: number }
function ns.CombatLog.Read(args)
    local eventLimit = math.max(1, math.min(RECAP_EVENTS, tonumber(args.eventLimit) or 40))
    local health, healthMax = playerHealth()
    local base = {
        capacity = CAPACITY,
        maxAgeSeconds = MAX_AGE,
        retainedCount = math.min(written, CAPACITY),
        health = health,
        healthMax = healthMax,
        inCombat = UnitAffectingCombat and UnitAffectingCombat("player") == true,
        dead = UnitIsDeadOrGhost and UnitIsDeadOrGhost("player") == true,
    }
    if args.view == "recent" then
        local seconds = math.max(1, math.min(MAX_AGE, tonumber(args.lastSeconds) or 30))
        local rows = since(time() - seconds)
        base.view = "recent"
        base.events = trimEvents(rows, eventLimit)
        base.count = #base.events
        base.matched = #rows
        base.truncated = #rows > #base.events
        base.note =
            "Combat involving the player since login/reload: damage, misses, heals and debuffs taken, and the player's own casts. Health is read when each event arrives and is approximate."
        return base
    end
    local limit = math.max(1, math.min(MAX_DEATHS, tonumber(args.deaths) or 1))
    local out = {}
    for i = 1, math.min(limit, #deaths) do
        local recap = {}
        for key, value in pairs(deaths[i]) do
            recap[key] = value
        end
        recap.secondsAgo = time() - recap.diedAt
        recap.events = trimEvents(recap.events, eventLimit)
        out[#out + 1] = recap
    end
    base.view = "deaths"
    base.deaths = out
    base.deathCount = #deaths
    base.note = #deaths == 0
            and "No deaths were recorded since login/reload. Deaths before a reload are not kept."
        or "Newest death first. Health is read when each event arrives and is approximate."
    return base
end
