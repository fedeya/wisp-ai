local helper = require("addon.tests.support")

it(
    "Lua discovery distinguishes missing, wrong-version, partial and complete Questie providers",
    function()
        local env = helper.env()
        setfenv(1, env)
        do
            C = {}
            C_AddOns = {
                GetAddOnMetadata = function()
                    return "test"
                end,
            }
        end
        helper.addon("Integrations.lua", env)

        assert(C.IntegrationReport().questie.status == "missing")
        LibQuestieDB = {
            flavor = { expansion = "Classic" },
            RequireContract = function()
                return true
            end,
            Npc = { Get = function() end, Exists = function() end },
        }
        assert(C.IntegrationReport().questie.status == "incompatible")
        LibQuestieDB.flavor.expansion = "Forever"
        assert(C.IntegrationReport().questie.status == "partial")
        Questie = { IsForever = true }
        QuestieLoader = {
            ImportModule = function()
                error("not ready")
            end,
        }
        assert(C.IntegrationReport().questie.status == "partial")
        QuestieLoader.ImportModule = function()
            return { GetClassTrainers = function() end, townsfolk = {} }
        end
        assert(C.IntegrationReport().questie.status == "partial")
        LibQuestieDB.Quest = LibQuestieDB.Npc
        LibQuestieDB.Object = LibQuestieDB.Npc
        assert(C.IntegrationReport().questie.status == "ready")
        LibQuestieDB.RequireContract = function()
            error("contract mismatch")
        end
        assert(C.IntegrationReport().questie.status == "incompatible")
    end
)
