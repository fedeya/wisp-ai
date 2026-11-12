local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    env.ns = helper.namespace()
    env.C_EncodingUtil = { SerializeJSON = require("dkjson").encode }
    env.time = function()
        return 123
    end
    env.CreateFrame = function()
        return { RegisterEvent = function() end, SetScript = function() end }
    end
    env.UnitExists = function(unit)
        assert(unit == "pet")
        return true
    end
    env.UnitGUID = function()
        return "Pet-1"
    end
    env.UnitName = function(unit)
        return unit == "pet" and "Wolf" or "Hunter"
    end
    env.UnitLevel = function()
        return 20
    end
    env.Enum =
        { SpellBookSpellBank = { Pet = 1 }, SpellBookItemType = { Spell = 1, PetAction = 3 } }
    env.C_SpellBook = {
        HasPetSpells = function()
            return 2
        end,
        GetSpellBookItemInfo = function(i, bank)
            assert(bank == 1)
            return { itemType = 1, spellID = 100 + i, name = "Ability " .. i, isOffSpec = false }
        end,
    }
    env.GetPetActionInfo = function(i)
        if i == 1 then
            return "PET_ATTACK", nil, true, false, false, false
        end
        if i == 2 then
            return "Bite", nil, false, false, true, false, 101
        end
        if i == 3 then
            return "Passive", nil, false, false, false, false, 103
        end
        if i == 4 then
            return "Other button", nil, false, false, false, false
        end
    end
    helper.addon("Character/Pet.lua", env)
    helper.addon("Character/Inspect.lua", env)
    return env,
        function()
            return env.ns.Character.Inspect({ kind = "pet", args = {} }).data
        end
end

describe("owned pet inspection", function()
    it("keeps useful sections when optional APIs fail and never mutates the game", function()
        local env, read = setup()
        env.UnitName = function(unit)
            assert.equal("pet", unit, "do not attach unrelated restricted player names")
            return "Wolf"
        end
        local mutations = 0
        for _, key in ipairs({
            "CastSpell",
            "CastPetAction",
            "TogglePetAutocast",
            "PetAttack",
            "PetFollow",
            "PetDismiss",
            "SummonPet",
            "SendChatMessage",
            "BuyTrainerService",
        }) do
            env[key] = function()
                mutations = mutations + 1
                error("game mutation")
            end
        end
        env.C_SpellBook.GetSpellBookItemInfo = function(i)
            if i == 2 then
                error("restricted")
            end
            return { itemType = 1, spellID = 101 }
        end
        local result = read()
        assert.equal("partial", result.learned.status)
        assert.is_false(result.learned.complete)
        assert.equal(1, #result.learned.entries)
        env.C_SpellBook = nil
        result = read()
        assert.equal("unknown", result.learned.status)
        assert.is_nil(result.learned.entries)
        assert.equal("available", result.identity.status)
        assert.equal("disabled", result.actionBar.entries[2].autocast)
        env.GetPetActionInfo = nil
        assert.equal("unknown", read().actionBar.status)
        assert.equal(0, mutations)
    end)

    it("invalidates all sections on mid-read despawn or unreadable identity", function()
        for _, value in ipairs({ false, "restricted" }) do
            local env, read = setup()
            env.GetPetActionInfo = function()
                env.UnitExists = function()
                    if value == "restricted" then
                        error("restricted")
                    end
                    return value
                end
            end
            local result = read()
            assert.equal("unknown", result.presence)
            for _, key in ipairs({ "identity", "learned", "actionBar" }) do
                assert.equal("stale", result[key].status)
                assert.is_nil(result[key].entries)
                assert.is_nil(result[key].guid)
            end
        end
    end)

    it(
        "does not turn malformed empty buttons, restricted flags or levels into negative facts",
        function()
            local env, read = setup()
            env.GetPetActionInfo = function(i)
                if i == 1 then
                    return nil, nil, false, false, true, true, 101
                end
                if i == 2 then
                    return "Bite", nil, false, false, true, 0, 101
                end
                if i == 3 then
                    return "Bite", nil, false, false, false, false, 101
                end
            end
            env.UnitLevel = function()
                return -1
            end
            local result = read()
            assert.equal("unknown", result.actionBar.entries[1].kind)
            assert.equal("unknown", result.actionBar.entries[2].autocast)
            assert.equal("not_autocastable", result.actionBar.entries[3].autocast)
            assert.equal("partial", result.identity.status)
            assert.is_nil(result.identity.level)
        end
    )

    it("reads learned bank separately from command tokens and manual autocast refresh", function()
        local env, read = setup()
        local first = read()
        assert.equal("present", first.presence)
        assert.equal("Wolf", first.identity.name)
        assert.equal(20, first.identity.level)
        assert.equal(2, #first.learned.entries)
        assert.equal(102, first.learned.entries[2].spellId)
        assert.equal("command", first.actionBar.entries[1].kind)
        assert.equal("disabled", first.actionBar.entries[2].autocast)
        assert.equal("not_autocastable", first.actionBar.entries[3].autocast)
        assert.equal("unknown", first.actionBar.entries[4].kind)
        assert.equal("unknown", first.actionBar.entries[4].autocast)
        assert.equal("partial", first.actionBar.status)
        assert.is_false(first.actionBar.complete)
        env.GetPetActionInfo = function(i)
            if i == 2 then
                return "Bite", nil, false, false, true, true, 101
            end
        end
        assert.equal("enabled", read().actionBar.entries[2].autocast)
        assert.equal("disabled", first.actionBar.entries[2].autocast)
    end)

    for _, flags in ipairs({
        { label = "true", allowed = true, enabled = true },
        { label = "false", allowed = false, enabled = false },
        { label = "missing" },
        { label = "missing allowed", enabled = true },
        { label = "missing enabled", allowed = true },
        { label = "secret allowed", secretAllowed = true, enabled = true },
        { label = "secret enabled", allowed = true, secretEnabled = true },
        { label = "malformed allowed", allowed = "false", enabled = false },
        { label = "malformed enabled", allowed = true, enabled = 0 },
    }) do
        it("keeps missing-ID slots unknown with " .. flags.label .. " autocast flags", function()
            local env, read = setup()
            local secret = {}
            env.issecretvalue = function(value)
                return value == secret
            end
            local original = env.GetPetActionInfo
            env.GetPetActionInfo = function(i)
                if i == 4 then
                    return "Bite",
                        nil,
                        false,
                        false,
                        flags.secretAllowed and secret or flags.allowed,
                        flags.secretEnabled and secret or flags.enabled,
                        nil
                end
                return original(i)
            end
            local result = read()
            assert.equal("present", result.presence)
            assert.equal("available", result.identity.status)
            assert.equal("Pet-1", result.identity.guid)
            assert.equal("Wolf", result.identity.name)
            assert.equal(20, result.identity.level)
            assert.equal("available", result.learned.status)
            assert.is_true(result.learned.complete)
            assert.equal(101, result.learned.entries[1].spellId)
            assert.equal(102, result.learned.entries[2].spellId)
            local bar = result.actionBar
            assert.equal("partial", bar.status)
            assert.is_false(bar.complete)
            assert.equal(10, #bar.entries)
            assert.equal("command", bar.entries[1].kind)
            assert.equal("not_applicable", bar.entries[1].autocast)
            assert.equal("spell", bar.entries[2].kind)
            assert.equal("disabled", bar.entries[2].autocast)
            assert.equal("not_autocastable", bar.entries[3].autocast)
            assert.equal("Bite", bar.entries[4].name)
            assert.equal("unknown", bar.entries[4].kind)
            assert.equal("unknown", bar.entries[4].autocast)
            assert.is_nil(bar.entries[4].spellId)
            assert.equal("empty", bar.entries[5].kind)
            assert.equal(123, bar.capturedAt)
            local envelope = env.ns.Character.Inspect({ kind = "pet", args = {} })
            assert.equal("available", envelope.status)
            assert.is_true(#env.C_EncodingUtil.SerializeJSON(envelope) <= 16384)
        end)
    end

    it(
        "preserves raw UTF-8 identity and bar bytes across three- and four-byte boundaries",
        function()
            for _, character in ipairs({ "界", "🐺" }) do
                local env, read = setup()
                local prefix = string.rep("a", 95)
                local name = prefix .. character
                env.UnitName = function()
                    return name
                end
                env.GetPetActionInfo = function(i)
                    if i == 2 then
                        return name, nil, false, false, true, true, 101
                    end
                end
                local result = read()
                assert.equal(prefix, result.identity.name)
                assert.equal(prefix, result.actionBar.entries[2].name)
                assert.equal(95, #result.identity.name)
                assert.equal(95, #result.actionBar.entries[2].name)
                assert.is_true(result.identity.nameClipped)
                assert.is_true(result.actionBar.entries[2].nameClipped)
                assert.equal("enabled", result.actionBar.entries[2].autocast)

                prefix = string.rep("a", 96 - #character) .. character
                name = prefix .. character
                result = read()
                assert.equal(prefix, result.identity.name)
                assert.equal(prefix, result.actionBar.entries[2].name)
                assert.equal(96, #result.identity.name)
                assert.equal(96, #result.actionBar.entries[2].name)
                assert.is_true(result.identity.nameClipped)
                assert.is_true(result.actionBar.entries[2].nameClipped)

                name = prefix
                result = read()
                assert.equal(prefix, result.identity.name)
                assert.equal(prefix, result.actionBar.entries[2].name)
                assert.is_false(result.identity.nameClipped)
                assert.is_false(result.actionBar.entries[2].nameClipped)
            end
        end
    )

    it("does not retain old abilities after swap and invalidates a mid-read swap", function()
        local env, read = setup()
        assert.equal(101, read().learned.entries[1].spellId)
        env.UnitGUID = function()
            return "Pet-2"
        end
        env.C_SpellBook.HasPetSpells = function()
            return 0
        end
        assert.equal(0, #read().learned.entries)
        env.C_SpellBook.HasPetSpells = function()
            env.UnitGUID = function()
                return "Pet-3"
            end
            return 2
        end
        local swapped = read()
        assert.equal("unknown", swapped.presence)
        assert.equal("stale", swapped.learned.status)
        assert.is_nil(swapped.learned.entries)
        assert.is_nil(swapped.identity.guid)
    end)

    it("requires direct readable absence and never treats unreadable spellbook as empty", function()
        local env, read = setup()
        for _, value in ipairs({ -1, 0 / 0, math.huge, "2", true, {} }) do
            env.C_SpellBook.HasPetSpells = function()
                return value
            end
            assert.equal("unknown", read().learned.status)
        end
        env.C_SpellBook.HasPetSpells = function()
            return nil
        end
        assert.equal("unknown", read().learned.status)
        env.UnitExists = function()
            return false
        end
        assert.equal("absent", read().presence)
        env.UnitExists = function()
            error("restricted")
        end
        assert.equal("unknown", read().presence)
        env.UnitExists = function()
            return true
        end
        env.UnitGUID = function()
            return nil
        end
        assert.equal("unknown", read().presence)
    end)

    it("preserves partial enumeration, malformed/secret uncertainty and bounded scans", function()
        local env, read = setup()
        local secret = {}
        env.issecretvalue = function(value)
            return value == secret
        end
        env.C_SpellBook.HasPetSpells = function()
            return 100000
        end
        local calls = 0
        env.C_SpellBook.GetSpellBookItemInfo = function(i)
            calls = calls + 1
            if i == 2 then
                return secret
            end
            return { itemType = 1, spellID = i, name = string.rep("é", 200) }
        end
        env.GetPetActionInfo = function(i)
            if i == 1 then
                return "Bite", nil, false, false, true, secret, 101
            end
        end
        local result = read()
        assert.is_true(calls <= 64)
        assert.equal("partial", result.learned.status)
        assert.is_false(result.learned.complete)
        assert.is_true(result.learned.omitted)
        assert.is_true(result.learned.entries[1].nameClipped)
        assert.equal(96, #result.learned.entries[1].name)
        assert.equal("unknown", result.actionBar.entries[1].autocast)
        assert.equal(123, result.learned.capturedAt)
        env.UnitGUID = function()
            return secret
        end
        assert.equal("unknown", read().presence)
    end)

    it("does not label pet-bank commands or malformed enums as learned spells", function()
        local env, read = setup()
        env.C_SpellBook.GetSpellBookItemInfo = function(i)
            return { itemType = i == 1 and 3 or 1, spellID = 101, name = "Button" }
        end
        local result = read()
        assert.equal(1, #result.learned.entries)
        assert.equal(2, result.learned.entries[1].slot)
        env.Enum.SpellBookItemType = {}
        assert.equal("unknown", read().learned.status)
    end)
end)
