local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function GetRealmName()
            return "Vorn"
        end
        function UnitFactionGroup()
            return "Horde"
        end
        C_Map = {
            GetAreaInfo = function(areaId)
                return ({ [40] = "Páramos de Poniente", [17] = "Los Baldíos" })[areaId]
            end,
        }
        C_Spell = {
            GetSpellInfo = function(id)
                return id == 3855 and { name = "Botas de seda de araña" } or nil
            end,
        }
    end
    helper.addon("Integrations/Integrations.lua", env)
    helper.addon("Integrations/Auctionator.lua", env)
    helper.addon("Integrations/Sources.lua", env)
end

it("source names come from QuestieDB and the spell API with cached prices in one read", function()
    local env = helper.env()
    setup(env)
    local npcs = { [2266] = { name = "Bruto gnoll", spawns = { [40] = {}, [17] = {} } } }
    local quests = { [875] = { name = "Destripadoras alabruja", requiredLevel = 14 } }
    env.LibQuestieDB = {
        flavor = { expansion = "Forever" },
        RequireContract = function()
            return true
        end,
        Npc = {
            Exists = function(id)
                return npcs[id] ~= nil
            end,
            Get = function(id, key)
                return npcs[id] and npcs[id][key]
            end,
        },
        Quest = {
            Exists = function(id)
                return quests[id] ~= nil
            end,
            Get = function(id, key)
                return quests[id] and quests[id][key]
            end,
        },
    }
    env.Auctionator = {
        API = {
            v1 = {
                GetAuctionPriceByItemID = function(_, id)
                    return id == 4320 and 7000 or nil
                end,
                GetAuctionAgeByItemID = function()
                    return 0
                end,
            },
        },
    }
    local result = env.ns.Integrations.InspectIntegration({
        kind = "source_names",
        args = {
            itemIds = { 4320, 15700 },
            npcIds = { 2266, 9 },
            questIds = { 875 },
            spellIds = { 3855, 1 },
            useQuestie = true,
        },
    })
    assert.equals("available", result.status)
    local data = result.data
    assert.same({ "Los Baldíos", "Páramos de Poniente" }, data.npcs[1].zones)
    assert.equals("Bruto gnoll", data.npcs[1].name)
    assert.equals(1, #data.npcs)
    assert.same({ id = 875, name = "Destripadoras alabruja", requiredLevel = 14 }, data.quests[1])
    assert.same({ id = 3855, name = "Botas de seda de araña" }, data.spells[1])
    assert.same({ id = 1 }, data.spells[2])
    assert.equals(7000, data.prices[1].unitPriceCopper)
    assert.equals("unknown", data.prices[2].status)
    assert.equals("available", data.priceStatus)
end)

it("missing QuestieDB or Auctionator leaves names and prices unavailable, not failed", function()
    local env = helper.env()
    setup(env)
    local data = env.ns.Integrations.InspectIntegration({
        kind = "source_names",
        args = { itemIds = { 4320 }, npcIds = { 2266 }, questIds = {}, spellIds = {} },
    }).data
    assert.same({}, data.npcs)
    assert.equals("unavailable", data.namesStatus.npcs)
    assert.equals("unavailable", data.priceStatus)
    assert.is_truthy(data.priceError)
end)

it("an incompatible QuestieDB or a disabled Questie keeps prices and spell names", function()
    local env = helper.env()
    setup(env)
    env.LibQuestieDB = {
        flavor = { expansion = "Forever" },
        RequireContract = function()
            error("contract 4 is not supported")
        end,
    }
    env.Auctionator = {
        API = {
            v1 = {
                GetAuctionPriceByItemID = function()
                    return 500
                end,
            },
        },
    }
    local args = { itemIds = { 4320 }, npcIds = { 2266 }, questIds = {}, spellIds = { 3855 } }
    local result = env.ns.Integrations.InspectIntegration({ kind = "source_names", args = args })
    assert.equals("available", result.status)
    assert.equals("unavailable", result.data.namesStatus.npcs)
    assert.equals(500, result.data.prices[1].unitPriceCopper)
    assert.equals("Botas de seda de araña", result.data.spells[1].name)

    local lookups = 0
    env.LibQuestieDB.RequireContract = function()
        lookups = lookups + 1
        return true
    end
    args.useQuestie = false
    result = env.ns.Integrations.InspectIntegration({ kind = "source_names", args = args })
    assert.equals(0, lookups)
    assert.equals("unavailable", result.data.namesStatus.npcs)
end)
