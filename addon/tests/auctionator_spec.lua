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
    helper.addon("Integrations/Auctionator.lua", env)
end

it("Auctionator discovery distinguishes missing, incompatible, partial and ready APIs", function()
    local env = helper.env()
    setup(env)
    local report = env.ns.Integrations._AuctionatorReport
    assert.same({ status = "missing" }, report())
    env.Auctionator = {}
    assert.same({ status = "incompatible", version = "unknown" }, report())
    env.Auctionator.API = { v1 = {} }
    assert.equals("incompatible", report().status)
    env.Auctionator.API.v1.GetAuctionPriceByItemID = function() end
    assert.equals("partial", report().status)
    env.Auctionator.API.v1.GetAuctionAgeByItemID = function() end
    assert.equals("ready", report().status)
    env.Auctionator.API.v1.GetAuctionPriceByItemID = nil
    assert.equals("incompatible", report().status)
end)

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
        assert(ns.Integrations._AuctionatorReport().status == "ready")
        Auctionator.API.v1.GetAuctionAgeByItemID = nil
        assert(ns.Integrations._AuctionatorReport().status == "partial")
        assert(not ns.Integrations.ReadAuctionatorPrices({ itemIds = { 1 } }).prices[1].ageKnown)
        Auctionator = nil
        assert(
            ns.Integrations.InspectIntegration({ kind = "item_prices", args = { itemIds = { 1 } } }).status
                == "unavailable"
        )
    end
)
