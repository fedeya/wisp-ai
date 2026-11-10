local _, ns = ...
local revision = "bf57434eafabf507beae49521cb5debb9ff69d01"
local function contains(values, value)
    for _, entry in ipairs(values or {}) do
        if entry == value then
            return true
        end
    end
    return false
end
function ns.Character.QueryTraining(args)
    local _, playerClass = UnitClass("player")
    local _, _, race = UnitRace("player")
    local faction = UnitFactionGroup("player")
    local token = args.class or playerClass
    local class = assert(ns.Character.TrainingData[token], "No catalog for this class")
    local rows, unresolved = {}, 0
    local query = args.query and string.lower(args.query)
    local function add(id, level, data, method)
        if level < (args.minLevel or 0) or level > (args.maxLevel or 60) then
            return
        end
        if args.spellId and id ~= args.spellId then
            return
        end
        if token == playerClass then
            if data.race and data.race ~= race then
                return
            end
            if data.races and not contains(data.races, race) then
                return
            end
            if data.faction and data.faction ~= faction then
                return
            end
        end
        local info = C_Spell.GetSpellInfo(id)
        if not info then
            unresolved = unresolved + 1
            if C_Spell.RequestLoadSpellData then
                C_Spell.RequestLoadSpellData(id)
            end
        end
        if query and (not info or not string.find(string.lower(info.name), query, 1, true)) then
            return
        end
        local row = {
            spellId = id,
            name = info and info.name,
            requiredLevel = level,
            method = method,
            baseCostCopper = data.cost,
            requiredSpellIds = data.requiredIds,
            requiredTalentId = data.requiredTalentId,
            race = data.race,
            races = data.races,
            faction = data.faction,
            questIds = data.quests,
            areaId = data.area,
        }
        if token == playerClass and C_SpellBook and C_SpellBook.IsSpellKnown then
            row.learned = C_SpellBook.IsSpellKnown(id, Enum.SpellBookSpellBank.Player)
        end
        rows[#rows + 1] = row
    end
    for level, spells in pairs(class.spellsByLevel or {}) do
        for _, spell in ipairs(spells) do
            add(spell.id, level, spell, "trainer")
        end
    end
    for id, variants in pairs((ns.Character.TrainingQuestSpells or {})[token] or {}) do
        for _, variant in ipairs(variants) do
            add(id, variant.level, variant, "quest")
        end
    end
    table.sort(rows, function(a, b)
        if a.requiredLevel ~= b.requiredLevel then
            return a.requiredLevel < b.requiredLevel
        end
        if a.spellId ~= b.spellId then
            return a.spellId < b.spellId
        end
        return (a.questIds and a.questIds[1] or 0) < (b.questIds and b.questIds[1] or 0)
    end)
    local page, offset, limit = {}, args.offset or 0, args.limit or 30
    for index = offset + 1, math.min(#rows, offset + limit) do
        page[#page + 1] = rows[index]
    end
    return {
        class = token,
        spells = page,
        total = #rows,
        nextOffset = offset + limit < #rows and offset + limit or nil,
        unresolvedNames = unresolved,
        version = "forever",
        source = "What's Training? Forever class and quest tables",
        sourceUrl = "https://github.com/fusionpit/WhatsTraining/tree/"
            .. revision
            .. "/Classes/Camelot",
        revision = revision,
        note = "Static catalog, not current trainer offers. Base prices exclude discounts. Learned is only reported for the current class; it does not prove eligibility. Quest variants retain race requirements. Talent-only unlocks, pet training and weapon skills are not exhaustive. Unresolved names require retry after client spell data loads; no match is not proof of absence.",
    }
end
