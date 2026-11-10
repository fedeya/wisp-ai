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
    helper.addon("Integrations/Integrations.lua", env)
    helper.addon("Integrations/Questie.lua", env)
    helper.addon("Integrations/Syndicator.lua", env)
    helper.addon("Integrations/Auctionator.lua", env)
end

it("reports missing providers without requiring their APIs at load time", function()
    local env = helper.env()
    setup(env)
    assert.same({
        version = "unknown (unknown)",
        questie = {
            status = "missing",
            npcs = false,
            quests = false,
            objects = false,
            trainers = false,
            services = false,
        },
        syndicator = { status = "missing" },
        auctionator = { status = "missing" },
    }, env.ns.Integrations.IntegrationReport())
end)

it("aggregates independent readiness and bounded client/provider versions", function()
    local env = helper.env()
    setup(env)
    env.GetBuildInfo = function()
        return "1.16.0", "12345"
    end
    env.GetAddOnMetadata = function(name, field)
        assert.equals("Version", field)
        return name .. "-legacy"
    end
    env.Syndicator = {
        API = {
            IsReady = function()
                return true
            end,
            GetInventoryInfoByItemID = function() end,
        },
    }
    env.Auctionator = { API = { v1 = { GetAuctionPriceByItemID = function() end } } }
    local report = env.ns.Integrations.IntegrationReport()
    assert.equals("1.16.0 (12345)", report.version)
    assert.equals("missing", report.questie.status)
    assert.same({ status = "ready", version = "Syndicator-legacy" }, report.syndicator)
    assert.same({ status = "partial", version = "Auctionator-legacy" }, report.auctionator)

    env.Syndicator.API.IsReady = function()
        error("initializing")
    end
    env.C_AddOns = {
        GetAddOnMetadata = function()
            return string.rep("v", 100)
        end,
    }
    env.GetBuildInfo = function()
        return string.rep("x", 100), "12345"
    end
    report = env.ns.Integrations.IntegrationReport()
    assert.equals(string.rep("x", 80), report.version)
    assert.same({ status = "waiting", version = string.rep("v", 80) }, report.syndicator)
    assert.same({ status = "partial", version = string.rep("v", 80) }, report.auctionator)
end)

it("dispatches every inspection and preserves unavailable errors and timestamps", function()
    local env = helper.env()
    setup(env)
    for kind, message in pairs({
        questie_quest = "QuestieDB Forever is required",
        questie_chain = "QuestieDB Forever is required",
        object_locations = "QuestieDB Forever is not loaded",
        stored_item = "Syndicator inventory API is not ready",
        item_prices = "Auctionator price API is unavailable",
    }) do
        local result = env.ns.Integrations.InspectIntegration({ kind = kind })
        assert.equals("unavailable", result.status)
        assert.is_nil(result.data)
        assert.is_truthy(result.error:find(message, 1, true))
        assert.equals(123, result.capturedAt)
    end
    assert.is_nil(env.ns.Integrations.InspectIntegration({ kind = "unrecognized" }))
end)

it("dispatches successful reads with the existing data envelope and default arguments", function()
    local env = helper.env()
    setup(env)
    env.Auctionator = {
        API = {
            v1 = {
                GetAuctionPriceByItemID = function(caller, id)
                    assert.equals("WispAI", caller)
                    assert.equals(42, id)
                    return 1234
                end,
            },
        },
    }
    local result = env.ns.Integrations.InspectIntegration({
        kind = "item_prices",
        args = { itemIds = { 42 } },
    })
    assert.equals("available", result.status)
    assert.equals(1234, result.data.prices[1].unitPriceCopper)
    assert.equals("TestRealm", result.data.realm)
    assert.equals("Horde", result.data.faction)
    assert.equals(123, result.capturedAt)
    assert.is_nil(result.error)
    result = env.ns.Integrations.InspectIntegration({ kind = "item_prices" })
    assert.equals("available", result.status)
    assert.same({}, result.data.prices)
end)
