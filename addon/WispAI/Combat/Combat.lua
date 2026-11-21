local _, ns = ...

-- Death recaps and fight summaries from the game's own Death Recap and Damage
-- Meter. Addons cannot read the combat log on this client, so nothing here
-- listens to it. The player's deaths are copied at PLAYER_DEAD because the game
-- only offers the latest recap without an ID; group deaths and fight totals are
-- read on demand, after combat, when the meter's values are no longer secret.
local MAX_DEATHS, MAX_RECAP_EVENTS, MAX_GROUP_DEATHS, TOP_SPELLS = 5, 30, 5, 10
local RECAP_ATTEMPTS = 5
local deaths = {}

local function readable(value)
    return value ~= nil and not (issecretvalue and issecretvalue(value))
end

local function number(value)
    return readable(value) and type(value) == "number" and value or nil
end

local function positive(value)
    value = number(value)
    return value and value > 0 and value or nil
end

local function text(value)
    if not readable(value) or type(value) ~= "string" or value == "" then
        return nil
    end
    return (value:gsub("[%c|]", " "):sub(1, 80))
end

local function flag(value)
    return readable(value) and value == true or nil
end

-- Game tables are read defensively: anything that is not a table reads as empty.
local function list(value)
    return type(value) == "table" and value or {}
end

local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, result = pcall(fn, ...)
    return ok and result or nil
end

local function round(value)
    return math.floor(value * 10 + 0.5) / 10
end

local function inCombat()
    return (UnitAffectingCombat and UnitAffectingCombat("player") == true)
        or (InCombatLockdown and InCombatLockdown() == true)
        or false
end

-- One recap event in Wisp's shape. `diedAt` is the newest event's timestamp.
local function normalizeEvent(entry, index, maxHealth, diedAt)
    local event = text(entry.event)
    local environment = text(entry.environmentalType)
    local health = number(entry.currentHP)
    local at = number(entry.timestamp)
    return {
        event = event,
        spell = event == "SWING_DAMAGE" and "Melee" or text(entry.spellName) or environment,
        spellId = positive(entry.spellId),
        environment = environment,
        source = not flag(entry.hideCaster) and text(entry.sourceName) or nil,
        amount = number(entry.amount),
        overkill = positive(entry.overkill),
        absorbed = positive(entry.absorbed),
        resisted = positive(entry.resisted),
        blocked = positive(entry.blocked),
        school = number(entry.school),
        deadly = flag(entry.deadly),
        avoidable = flag(entry.avoidable),
        health = health,
        healthPercent = health and maxHealth and math.floor(health / maxHealth * 100) or nil,
        secondsBeforeDeath = at and diedAt and round(diedAt - at) or nil,
        causedDeath = index == 1 or nil,
    }
end

-- Damage per source and ability, largest first, and the overall total.
local function totalsBySource(events)
    local totals, total = {}, 0
    for _, row in ipairs(events) do
        if row.amount then
            local key = (row.source or "?") .. "\0" .. (row.spell or "?")
            local entry = totals[key]
                or { source = row.source, ability = row.spell, amount = 0, hits = 0 }
            entry.amount = entry.amount + row.amount
            entry.hits = entry.hits + 1
            totals[key] = entry
            total = total + row.amount
        end
    end
    local ranked = {}
    for _, entry in pairs(totals) do
        ranked[#ranked + 1] = entry
    end
    table.sort(ranked, function(a, b)
        return a.amount > b.amount
    end)
    return ranked, total
end

-- Blizzard lists recap events newest first: event 1 caused the death.
-- A nil recapID reads the player's latest death.
local function readRecap(recapID)
    local recap = C_DeathRecap
    if not recap or not call(recap.HasRecapEvents, recapID) then
        return { recapAvailable = false }
    end
    local raw = list(call(recap.GetRecapEvents, recapID))
    if #raw == 0 then
        return { recapAvailable = false }
    end
    local maxHealth = positive(call(recap.GetRecapMaxHealth, recapID))
    local diedAt
    for _, entry in ipairs(raw) do
        local at = number(list(entry).timestamp)
        if at and (not diedAt or at > diedAt) then
            diedAt = at
        end
    end
    local events = {}
    for index = 1, math.min(#raw, MAX_RECAP_EVENTS) do
        if type(raw[index]) == "table" then
            events[#events + 1] = normalizeEvent(raw[index], index, maxHealth, diedAt)
        end
    end
    if #events == 0 then
        return { recapAvailable = false }
    end
    local bySource, total = totalsBySource(events)
    return {
        recapAvailable = true,
        maxHealth = maxHealth,
        killingBlow = events[1],
        damageTaken = total,
        damageBySource = bySource,
        secondsCovered = events[#events].secondsBeforeDeath,
        events = events,
    }
end

-- `place` holds what was true when the player died: time, zone and level.
local function recordDeath(place)
    local death = readRecap(nil)
    for key, value in pairs(place) do
        death[key] = value
    end
    table.insert(deaths, 1, death)
    deaths[MAX_DEATHS + 1] = nil
end

local function hasRecap()
    return C_DeathRecap ~= nil and call(C_DeathRecap.HasRecapEvents) == true
end

-- The recap can be ready a moment after PLAYER_DEAD (Blizzard's death dialog
-- polls HasRecapEvents), so check once a second and record as soon as it is
-- ready, or without a recap after the last attempt.
local function waitForRecap(place, attempt)
    if hasRecap() or attempt >= RECAP_ATTEMPTS then
        recordDeath(place)
        return
    end
    C_Timer.After(1, function()
        waitForRecap(place, attempt + 1)
    end)
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_DEAD")
frame:SetScript("OnEvent", function()
    local place = {
        diedAt = time(),
        zone = GetRealZoneText and text(call(GetRealZoneText)) or nil,
        subzone = GetSubZoneText and text(call(GetSubZoneText)) or nil,
        level = UnitLevel and number(call(UnitLevel, "player")) or nil,
    }
    if C_Timer and C_Timer.After then
        C_Timer.After(1, function()
            waitForRecap(place, 1)
        end)
    else
        recordDeath(place)
    end
end)

function ns.Combat.Clear()
    deaths = {}
end

local function trim(events, limit)
    local out = {}
    for index = 1, math.min(#events, limit) do
        out[index] = events[index]
    end
    return out
end

-- Returns the meter enums, or nil and why the meter cannot be read.
local function meter()
    local types = Enum and Enum.DamageMeterType
    local sessions = Enum and Enum.DamageMeterSessionType
    if not C_DamageMeter or not types or not sessions then
        return nil, "The game's damage meter is not available on this client."
    end
    if C_DamageMeter.IsDamageMeterAvailable then
        local ok, available, reason = pcall(C_DamageMeter.IsDamageMeterAvailable)
        if ok and available == false then
            return nil,
                text(reason)
                    or "The game's damage meter is off. Enable it under Options > Advanced Options > Damage Meter."
        end
    end
    if inCombat() then
        return nil,
            "Fight data from the game's damage meter is hidden during combat. Ask again after combat ends."
    end
    return { types = types, sessions = sessions }
end

local function groupDeaths(enums, eventLimit)
    if not enums.types.Deaths then
        return nil
    end
    local session =
        call(C_DamageMeter.GetCombatSessionFromType, enums.sessions.Current, enums.types.Deaths)
    local out = {}
    for _, source in ipairs(list(list(session).combatSources)) do
        if #out >= MAX_GROUP_DEATHS then
            break
        end
        source = list(source)
        if not flag(source.isLocalPlayer) then
            local recapID = positive(source.deathRecapID)
            local recap = recapID and readRecap(recapID) or { recapAvailable = false }
            out[#out + 1] = {
                name = text(source.name),
                class = text(source.classFilename),
                deathTimeSeconds = number(source.deathTimeSeconds),
                recapAvailable = recap.recapAvailable,
                killingBlow = recap.killingBlow,
                damageBySource = recap.damageBySource,
                events = recap.events and trim(recap.events, eventLimit),
            }
        end
    end
    return out
end

local function readFight(enums)
    local types, current = enums.types, enums.sessions.Current
    local fight = {
        durationSeconds = number(call(C_DamageMeter.GetSessionDurationSeconds, current)),
    }
    local guid = UnitGUID and call(UnitGUID, "player")
    local taken = types.DamageTaken
        and call(C_DamageMeter.GetCombatSessionSourceFromType, current, types.DamageTaken, guid)
    if type(taken) == "table" then
        fight.damageTaken = number(taken.totalAmount)
        local spells = {}
        for _, spell in ipairs(list(taken.combatSpells)) do
            spell = list(spell)
            local details = list(spell.combatSpellDetails)
            spells[#spells + 1] = {
                spellId = positive(spell.spellID),
                source = text(spell.creatureName) or text(details.unitName),
                amount = number(spell.totalAmount),
                overkill = positive(spell.overkillAmount),
                avoidable = flag(spell.isAvoidable),
                deadly = flag(spell.isDeadly),
            }
        end
        table.sort(spells, function(a, b)
            return (a.amount or 0) > (b.amount or 0)
        end)
        fight.damageTakenBySpell = trim(spells, TOP_SPELLS)
    end
    local done = types.DamageDone
        and call(C_DamageMeter.GetCombatSessionSourceFromType, current, types.DamageDone, guid)
    if type(done) == "table" then
        fight.damageDone = number(done.totalAmount)
    end
    local group = types.DamageTaken
        and call(C_DamageMeter.GetCombatSessionFromType, current, types.DamageTaken)
    if type(group) == "table" then
        local members = {}
        for _, source in ipairs(list(group.combatSources)) do
            source = list(source)
            members[#members + 1] = {
                name = text(source.name),
                class = text(source.classFilename),
                isPlayer = flag(source.isLocalPlayer),
                damageTaken = number(source.totalAmount),
            }
        end
        fight.groupDamageTaken = members
    end
    return fight
end

---Reads the player's death recaps (`view = "deaths"`) or the last fight from the
---game's damage meter (`view = "fight"`).
---@param args { view?: string, deaths?: number, includeGroup?: boolean, eventLimit?: number }
function ns.Combat.Read(args)
    local eventLimit = math.max(1, math.min(MAX_RECAP_EVENTS, tonumber(args.eventLimit) or 20))
    local result = {
        inCombat = inCombat(),
        dead = UnitIsDeadOrGhost and UnitIsDeadOrGhost("player") == true,
    }
    if args.view == "fight" then
        result.view = "fight"
        local enums, reason = meter()
        if enums then
            result.fight = readFight(enums)
        else
            result.unavailable = reason
        end
        result.note =
            "Totals for the current or last fight from the game's damage meter. Names the meter hides are left out."
        return result
    end
    local limit = math.max(1, math.min(MAX_DEATHS, tonumber(args.deaths) or 1))
    local out = {}
    for index = 1, math.min(limit, #deaths) do
        local death = {}
        for key, value in pairs(deaths[index]) do
            death[key] = value
        end
        death.secondsAgo = time() - death.diedAt
        death.events = death.events and trim(death.events, eventLimit) or nil
        out[#out + 1] = death
    end
    result.view = "deaths"
    result.deaths = out
    result.deathCount = #deaths
    if args.includeGroup then
        local enums, reason = meter()
        if enums then
            result.groupDeaths = groupDeaths(enums, eventLimit)
        else
            result.groupUnavailable = reason
        end
    end
    result.note = #deaths == 0 and "No deaths of this character were recorded since login/reload."
        or "Newest death first, from the game's Death Recap. Events are newest first; the first caused the death."
    return result
end
