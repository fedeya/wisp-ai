local helper = require("addon.tests.support")

it("diag compares the loaded addon with the bundled addon version", function()
    local env = helper.env()
    setfenv(1, env)
    do
        logs = {}
        SlashCmdList = {}
        ns = helper.namespace({ slot = 1 })
        function time()
            return 1
        end
        function CreateFrame()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        DEFAULT_CHAT_FRAME = {
            AddMessage = function(_, text)
                logs[#logs + 1] = text
            end,
        }
        C_AddOns = {
            GetAddOnMetadata = function(name, key)
                assert(name == "WispAI" and key == "Version")
                return "1.0.0"
            end,
        }
    end
    helper.addon("Core.lua", env)

    assert(ns.VERSION == 1)
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("Addon 1.0.0", 1, true))
    assert(logs[1]:find("desktop/bridge unknown", 1, true))
    assert(not logs[1]:find("version mismatch", 1, true))
    ns.db = { drafts = {} }
    ns.Transport.Acknowledge = function() end
    GetTime = function()
        return 1
    end
    ns.Chat.ReceiveSnapshot({
        v = 1,
        session = ns.session,
        rev = 1,
        connected = true,
        bridgeVersion = "0.0.7",
        expectedAddonVersion = "1.0.1",
    })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("desktop/bridge 0.0.7", 1, true))
    assert(logs[1]:find("version mismatch", 1, true))
    ns.Chat.ReceiveSnapshot({
        v = 1,
        session = ns.session,
        rev = 2,
        connected = true,
        bridgeVersion = "0.0.7",
        expectedAddonVersion = "1.0.0",
    })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(not logs[1]:find("version mismatch", 1, true))
    ns.Chat.ReceiveSnapshot({ v = 1, session = ns.session, rev = 3, connected = true })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("desktop/bridge unknown", 1, true))
end)
