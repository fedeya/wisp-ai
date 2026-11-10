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
    helper.addon("Integrations/Syndicator.lua", env)
end

it("Syndicator discovery distinguishes missing, incompatible, waiting and ready APIs", function()
    local env = helper.env()
    setup(env)
    local report = env.ns.Integrations._SyndicatorReport
    assert.same({ status = "missing" }, report())
    env.Syndicator = {}
    assert.same({ status = "missing" }, report())
    env.Syndicator.API = {}
    assert.same({ status = "incompatible", version = "unknown" }, report())
    env.Syndicator.API.IsReady = function()
        return true
    end
    assert.equals("incompatible", report().status)
    env.Syndicator.API.GetInventoryInfoByItemID = function() end
    assert.equals("ready", report().status)
    env.Syndicator.API.IsReady = function()
        return false
    end
    assert.equals("waiting", report().status)
    env.Syndicator.API.IsReady = function()
        error("not initialized")
    end
    assert.equals("waiting", report().status)
end)

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
        assert(ns.Integrations._SyndicatorReport().status == "waiting")
    end
)
