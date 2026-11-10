local helper = require("addon.tests.support")

local function setup(_ENV)
    do
        C = {}
        UnitClass = function()
            return "Mage", "MAGE"
        end
        UnitRace = function()
            return "Human", "Human", 1
        end
        UnitFactionGroup = function()
            return "Alliance"
        end
        C_Spell = {
            GetSpellInfo = function(id)
                return { name = id == 116 and "Descarga de Escarcha" or "Spell " .. id }
            end,
        }
        C_SpellBook = {
            IsSpellKnown = function(id)
                return id == 1459
            end,
        }
        Enum = { SpellBookSpellBank = { Player = 0 } }
    end
    helper.addon("TrainingData.lua", _ENV)
    helper.addon("Training.lua", _ENV)
end

it("Forever mage localized lookup finds the actual catalog rank without a trainer", function()
    local _ENV = helper.env()
    setup(_ENV)

    local result = C.QueryTraining({ query = "descarga de escarcha" })
    assert(result.total == 1 and result.spells[1].spellId == 116)
    assert(result.spells[1].requiredLevel == 4 and result.spells[1].baseCostCopper == 100)
    assert(result.spells[1].learned == false and result.version == "forever")
end)

it("all nine classes load, requirements and pagination survive", function()
    local _ENV = helper.env()
    setup(_ENV)

    local count = 0
    for token in pairs(C.TrainingData) do
        count = count + 1
        local r = C.QueryTraining({ class = token, limit = 1 })
        assert(r.total > 1 and #r.spells == 1 and r.nextOffset == 1)
        local next = C.QueryTraining({ class = token, limit = 1, offset = 1 })
        assert(#next.spells == 1)
        if token ~= "MAGE" then
            assert(r.spells[1].learned == nil)
        end
    end
    assert(count == 9)
    local r = C.QueryTraining({ spellId = 143 })
    assert(r.spells[1].requiredSpellIds[1] == 133)
    local teleport = C.QueryTraining({ spellId = 3563 })
    assert(teleport.total == 0)
    local quest = C.QueryTraining({ class = "WARRIOR", spellId = 71 })
    assert(
        quest.total > 0
            and quest.spells[1].method == "quest"
            and quest.spells[1].questIds[1] == 1498
    )
end)

it("missing localized data is explicit and requests loading", function()
    local _ENV = helper.env()
    setup(_ENV)

    local requests = 0
    C_Spell.GetSpellInfo = function()
        return nil
    end
    C_Spell.RequestLoadSpellData = function()
        requests = requests + 1
    end
    local r = C.QueryTraining({ query = "descarga de escarcha" })
    assert(r.total == 0 and r.unresolvedNames > 0 and requests > 0)
    r = C.QueryTraining({ spellId = 116 })
    assert(r.total == 1 and r.spells[1].requiredLevel == 4)
end)
