local _, ns = ...

-- Verified against Gethe/wow-ui-source forever 4cd0ab752a77164f654ccbca9d0c1fe8dafceebe.
-- No cache: each explicit inspection observes the current owned unit token.
local MAX_SPELLS, MAX_BAR, JSON_BUDGET = 64, 10, 16384
local function readable(value)
    if type(issecretvalue) == "function" then
        local ok, secret = pcall(issecretvalue, value)
        return ok and secret == false
    end
    return true
end
local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, value = pcall(fn, ...)
    if ok and readable(value) then
        return value
    end
end
local function integer(value, min, max)
    return readable(value)
        and type(value) == "number"
        and value >= min
        and value <= max
        and value == math.floor(value)
end
local function text(value, limit)
    if readable(value) and type(value) == "string" and value ~= "" then
        return ns.Shared.Text.TruncateUtf8Bytes(value, limit)
    end
end
local function section(source)
    return { status = "unknown", capturedAt = time(), source = source, complete = false }
end
local function identity()
    local exists = call(UnitExists, "pet")
    if exists == false then
        return "absent"
    end
    if exists ~= true then
        return "unknown"
    end
    local guid, name = call(UnitGUID, "pet"), call(UnitName, "pet")
    if not text(guid, 128) or #guid > 128 or not text(name, 96) then
        return "unknown"
    end
    return "present", guid, name
end
local function learned()
    local result = section("C_SpellBook Pet bank")
    local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Pet
    local types = Enum and Enum.SpellBookItemType
    if
        not integer(bank, 0, 2147483647)
        or type(types) ~= "table"
        or not integer(types.Spell, 0, 2147483647)
        or not integer(types.PetAction, 0, 2147483647)
        or type(C_SpellBook) ~= "table"
    then
        return result
    end
    local count = call(C_SpellBook.HasPetSpells)
    if not integer(count, 0, 1000000) or type(C_SpellBook.GetSpellBookItemInfo) ~= "function" then
        return result
    end
    result.entries, result.complete, result.omitted = {}, count <= MAX_SPELLS, count > MAX_SPELLS
    for index = 1, math.min(count, MAX_SPELLS) do
        local info = call(C_SpellBook.GetSpellBookItemInfo, index, bank)
        if type(info) == "table" and readable(info.itemType) then
            if
                info.itemType == types.Spell
                and integer(info.spellID, 1, 2147483647)
                and readable(info.isOffSpec)
                and (info.isOffSpec == nil or info.isOffSpec == false)
            then
                local name, clipped = text(info.name, 96)
                result.entries[#result.entries + 1] = {
                    slot = index,
                    spellId = info.spellID,
                    name = name,
                    nameClipped = clipped,
                }
            elseif info.itemType ~= types.PetAction then
                result.complete = false
                result.omitted = true
            end
        else
            result.complete = false
            result.omitted = true
        end
    end
    result.status = result.complete and "available" or "partial"
    return result
end
local function actionBar()
    local result = section("GetPetActionInfo slots 1-10")
    if type(GetPetActionInfo) ~= "function" then
        return result
    end
    result.entries, result.complete = {}, true
    for slot = 1, MAX_BAR do
        local ok, name, _, token, _, allowed, enabled, spellId = pcall(GetPetActionInfo, slot)
        local entry = { slot = slot, kind = "unknown", autocast = "unknown" }
        if ok and readable(name) and name == nil then
            if
                readable(token)
                and token == nil
                and readable(allowed)
                and allowed == nil
                and readable(enabled)
                and enabled == nil
                and readable(spellId)
                and spellId == nil
            then
                entry.kind, entry.autocast = "empty", "not_applicable"
            end
        elseif ok and text(name, 96) then
            entry.name, entry.nameClipped = text(name, 96)
            if readable(token) and token == true then
                entry.kind, entry.autocast = "command", "not_applicable"
            elseif readable(token) and token == false and integer(spellId, 1, 2147483647) then
                entry.kind, entry.spellId = "spell", spellId
                if readable(allowed) and allowed == false then
                    entry.autocast = "not_autocastable"
                elseif readable(allowed) and allowed == true and readable(enabled) then
                    if enabled == true then
                        entry.autocast = "enabled"
                    elseif enabled == false then
                        entry.autocast = "disabled"
                    end
                end
            end
            -- A named non-token slot without a readable spell ID is incomplete,
            -- not positive evidence of a non-spell button or inapplicable autocast.
        end
        if entry.kind == "unknown" or entry.autocast == "unknown" then
            result.complete = false
        end
        result.entries[#result.entries + 1] = entry
    end
    result.status = result.complete and "available" or "partial"
    return result
end

function ns.Character.ReadPet()
    local presence, guid, name = identity()
    local result = {
        presence = presence,
        identity = section("UnitExists/UnitGUID/UnitName/UnitLevel pet"),
        learned = section("C_SpellBook Pet bank"),
        actionBar = section("GetPetActionInfo slots 1-10"),
    }
    if presence ~= "present" then
        if presence == "absent" then
            result.identity.status, result.identity.complete = "available", true
            result.learned.status, result.actionBar.status = "not_applicable", "not_applicable"
        end
        return result
    end
    result.identity.guid = guid
    result.identity.name, result.identity.nameClipped = text(name, 96)
    local level = call(UnitLevel, "pet")
    if integer(level, 1, 255) then
        result.identity.level = level
    end
    result.identity.complete = result.identity.level ~= nil
    result.identity.status = result.identity.complete and "available" or "partial"
    result.learned, result.actionBar = learned(), actionBar()
    local after, afterGuid, afterName = identity()
    if after ~= "present" or afterGuid ~= guid or afterName ~= name then
        result.presence = "unknown"
        for _, key in ipairs({ "identity", "learned", "actionBar" }) do
            local old = result[key]
            result[key] = {
                status = "stale",
                capturedAt = old.capturedAt,
                source = old.source,
                complete = false,
            }
        end
    end
    -- Measure the escaped inspection envelope, not field lengths. Reserve
    -- >48 KiB for state_result/session/framing metadata (production Send adds
    -- these); never alter general transport limits.
    if C_EncodingUtil and type(C_EncodingUtil.SerializeJSON) == "function" then
        for _ = 1, MAX_SPELLS + MAX_BAR + 1 do
            local encoded = call(C_EncodingUtil.SerializeJSON, {
                status = "available",
                capturedAt = time(),
                source = "WoW addon live API",
                data = result,
            })
            if type(encoded) == "string" and #encoded <= JSON_BUDGET then
                return result
            end
            local target = result.learned.entries and #result.learned.entries > 0 and result.learned
                or result.actionBar.entries
                    and #result.actionBar.entries > 0
                    and result.actionBar
            if not target then
                break
            end
            table.remove(target.entries)
            target.status, target.complete, target.omitted = "partial", false, true
        end
    end
    error("Pet inspection JSON budget could not be verified")
end
