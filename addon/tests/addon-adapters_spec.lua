local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function GetRealmName()
            return "TestRealm"
        end
        function UnitFactionGroup()
            return "Horde"
        end
    end
    helper.addon("Integrations/AddonAdapters.lua", env)
    helper.addon("Integrations/Integrations.lua", env)
    helper.addon("Integrations/Locations.lua", env)
end

it(
    "quest details retain requirement semantics, unknown fields and fresh flags without claiming eligibility",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local quests = {
            [1] = {
                name = "First",
                requiredLevel = 10,
                preQuestGroup = { 2, 3 },
                preQuestSingle = { 4, 5 },
                startedBy = { 1 },
                objectivesText = { "Find the object" },
                objectives = { object = { { 99, "Test object" } } },
            },
        }
        LibQuestieDB = {
            flavor = { expansion = "Forever" },
            RequireContract = function(v)
                return v == 4
            end,
            Quest = {
                Exists = function(id)
                    return quests[id] ~= nil
                end,
                Get = function(id, key)
                    return quests[id] and quests[id][key]
                end,
            },
        }
        C_QuestLog = {
            IsQuestFlaggedCompleted = function(id)
                return id == 2
            end,
        }
        local result = ns.Integrations.ReadQuestieQuest({ questId = 1 })
        assert(
            result.status == "available"
                and result.data.preQuestGroup[2] == 3
                and result.data.preQuestSingle[2] == 5
        )
        assert(
            result.liveState.completionKnown
                and result.liveState.completed == false
                and not result.liveState.activeKnown
        )
        assert(
            result.reference.kind == "quest"
                and result.reference.id == 1
                and #result.unknownFields > 0
        )
        assert(ns.Integrations.ReadQuestieQuest({ questId = 999 }).status == "unknown")
        quests[1].objectivesText = { string.rep("x", 1000) }
        assert(ns.Integrations.ReadQuestieQuest({ questId = 1 }).truncated)
        quests[1].objectivesText = { string.rep("x", 399) .. "ñ" }
        assert(
            ns.Integrations.ReadQuestieQuest({ questId = 1 }).data.objectivesText[1]
                == string.rep("x", 399),
            "truncation must preserve valid UTF-8"
        )
        LibQuestieDB.flavor.expansion = "Classic"
        assert(
            ns.Integrations.InspectIntegration({ kind = "questie_quest", args = { questId = 1 } }).status
                == "unavailable"
        )
    end
)

it("quest graphs terminate on cycles and report depth, size and missing-record limits", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local quests = {
        [1] = { name = "First", preQuestGroup = { 2, 3 }, childQuests = { 4 } },
        [2] = { name = "Pre", childQuests = { 1 } },
        [4] = { name = "Next", nextQuestInChain = 1 },
    }
    LibQuestieDB = {
        flavor = { expansion = "Forever" },
        RequireContract = function()
            return true
        end,
        Quest = {
            Exists = function(id)
                return quests[id] ~= nil
            end,
            Get = function(id, key)
                return quests[id] and quests[id][key]
            end,
        },
    }
    local result = ns.Integrations.ReadQuestieChain({
        questId = 1,
        direction = "both",
        limit = 15,
        maxDepth = 4,
    })
    assert(#result.nodes == 3 and result.missingQuestIds[1] == 3 and not result.truncated)
    assert(not result.nodes[1].liveState.completionKnown)
    result = ns.Integrations.ReadQuestieChain({
        questId = 1,
        direction = "followups",
        limit = 15,
        maxDepth = 4,
    })
    assert(#result.nodes == 2 and #result.missingQuestIds == 0)
    result = ns.Integrations.ReadQuestieChain({
        questId = 1,
        direction = "both",
        limit = 1,
        maxDepth = 4,
    })
    assert(#result.nodes == 1 and result.truncated)
    quests[4].nextQuestInChain = 5
    quests[5] = { name = "Beyond limit" }
    assert(
        ns.Integrations.ReadQuestieChain({ questId = 1, direction = "followups", maxDepth = 1 }).truncated
    )
end)

it(
    "Questie sparse objective tuples serialize as objects without losing positional meaning",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        -- Quest 5041 has only the item group (3), with a missing tuple slot (2).
        local objectives = { [3] = { { [1] = 12708, [3] = 0 } } }
        local quest = {
            name = "Supplies for the Crossroads",
            startedBy = { { 3429 } },
            objectives = objectives,
        }
        LibQuestieDB = {
            flavor = { expansion = "Forever" },
            RequireContract = function()
                return true
            end,
            Quest = {
                Exists = function()
                    return true
                end,
                Get = function(_, key)
                    return quest[key]
                end,
            },
        }
        local function assertJSON(value)
            if type(value) ~= "table" then
                return
            end
            local count, highest, numbers, strings = 0, 0, false, false
            for key, child in pairs(value) do
                count = count + 1
                if type(key) == "number" then
                    assert(key >= 1 and key % 1 == 0)
                    numbers = true
                    highest = math.max(highest, key)
                else
                    assert(type(key) == "string")
                    strings = true
                end
                assertJSON(child)
            end
            assert(not (numbers and strings), "WoW JSON rejects mixed keys")
            assert(not numbers or highest == count, "WoW JSON rejects sparse arrays")
        end
        local result = ns.Integrations.InspectIntegration({
            kind = "questie_quest",
            args = { questId = 5041 },
        })
        assert(result.status == "available")
        assertJSON(result)
        local groups = result.data.data.objectives
        assert(groups["3"][1]["1"] == 12708 and groups["3"][1]["3"] == 0)
        assert(
            groups["1"] == nil and groups["3"][1]["2"] == nil,
            "missing positions must stay unknown"
        )
        assert(result.data.data.startedBy[1][1] == 3429, "dense arrays stay arrays")
        assert(
            objectives[3][1][1] == 12708 and objectives["3"] == nil,
            "provider data is never mutated"
        )
        quest.objectives = { [0] = false, label = "mixed", [4] = { value = true } }
        result = ns.Integrations.ReadQuestieQuest({ questId = 5041 })
        assertJSON(result)
        assert(result.data.objectives["0"] == false and result.data.objectives["4"].value)
    end
)

it(
    "Syndicator uses scoped public cached reads and guild opt-in without mutating provider rows",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local data = {
            characters = {
                {
                    character = "Alt",
                    realmNormalized = "TestRealm",
                    bags = 2,
                    bank = 4,
                    mail = 1,
                    auctions = 3,
                    equipped = 0,
                },
            },
            guilds = { { guild = "Guild", realmNormalized = "TestRealm", bank = 9 } },
        }
        Syndicator = {
            API = {
                IsReady = function()
                    return true
                end,
                GetInventoryInfoByItemID = function(id, realm, faction)
                    assert(id == 123 and realm and faction)
                    return data
                end,
            },
        }
        local result = ns.Integrations.FindStoredItem({ itemId = 123, limit = 20 })
        assert(
            result.cached
                and result.totalCached == 10
                and #result.matches == 1
                and result.cacheAge == "unknown"
        )
        result = ns.Integrations.FindStoredItem({ itemId = 123, includeGuild = true, limit = 1 })
        assert(
            result.totalCached == 19
                and result.truncated
                and #result.matches == 1
                and #data.characters == 1
                and data.characters[1].bank == 4
        )
        Syndicator.API.IsReady = function()
            return false
        end
        assert(
            ns.Integrations.InspectIntegration({ kind = "stored_item", args = { itemId = 123 } }).status
                == "unavailable"
        )
        assert(ns.Integrations.IntegrationReport().syndicator.status == "waiting")
    end
)

it(
    "Auctionator prices are unit copper values with coarse age, distinguishing unknown prices and ages",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        Auctionator = {
            API = {
                v1 = {
                    GetAuctionPriceByItemID = function(caller, id)
                        assert(caller == "WispAI")
                        if id == 1 then
                            return 450
                        elseif id == 3 then
                            return 900
                        end
                    end,
                    GetAuctionAgeByItemID = function(caller, id)
                        if id == 1 then
                            return 0
                        end
                    end,
                },
            },
        }
        local result = ns.Integrations.ReadAuctionatorPrices({ itemIds = { 1, 2, 3, 1 } })
        assert(
            #result.prices == 3
                and result.prices[1].unitPriceCopper == 450
                and result.prices[1].ageDays == 0
                and result.prices[1].ageKnown
        )
        assert(result.prices[2].status == "unknown" and result.prices[2].unitPriceCopper == nil)
        assert(
            result.prices[3].unitPriceCopper == 900
                and not result.prices[3].ageKnown
                and result.prices[3].ageDays == nil
        )
        assert(result.realm == "TestRealm" and result.cached)
        assert(ns.Integrations.IntegrationReport().auctionator.status == "ready")
        Auctionator.API.v1.GetAuctionAgeByItemID = nil
        assert(ns.Integrations.IntegrationReport().auctionator.status == "partial")
        assert(not ns.Integrations.ReadAuctionatorPrices({ itemIds = { 1 } }).prices[1].ageKnown)
        Auctionator = nil
        assert(
            ns.Integrations.InspectIntegration({ kind = "item_prices", args = { itemIds = { 1 } } }).status
                == "unavailable"
        )
    end
)

it("object spawns require verified native map frames and never query NPC-only fields", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_Map = {
        GetBestMapForUnit = function()
            return 1454
        end,
        GetMapInfo = function(id)
            if id == 1454 then
                return { name = "Orgrimmar" }
            end
        end,
        GetAreaInfo = function()
            return "Orgrimmar"
        end,
    }
    LibQuestieDB = {
        flavor = { expansion = "Forever" },
        RequireContract = function()
            return true
        end,
        EraToForever = function(_, x, y)
            return x, y
        end,
        Object = {
            Exists = function(id)
                return id == 99
            end,
            Get = function(id, key)
                assert(key ~= "subName" and key ~= "friendlyToFaction")
                if key == "name" then
                    return "Test chest"
                elseif key == "spawns" then
                    return { [1637] = { { 45, 55 } } }
                end
            end,
        },
    }
    local result = ns.Integrations.FindObjectLocations({ objectId = 99, mapId = 1454 })
    assert(
        result.total == 1
            and result.locations[1].objectId == 99
            and result.locations[1].reference.x == 45
    )
    LibQuestieDB.EraToForever = function(_, x, y)
        return x + 5, y
    end
    result = ns.Integrations.FindObjectLocations({ objectId = 99, mapId = 1454 })
    assert(result.total == 0 and result.skippedUnverifiedFrames == 1)
    LibQuestieDB.flavor.expansion = "Classic"
    assert(not pcall(ns.Integrations.FindObjectLocations, { objectId = 99, mapId = 1454 }))
end)
