local helper = require("addon.tests.support")

it("diag reports the loaded addon build, unknown bridge and actual version mismatches", function()
    local env = helper.env()
    setfenv(1, env)
    do
        logs = {}
        SlashCmdList = {}
        C = { slot = 1 }
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
                return "0.0.8-nightly.123.2"
            end,
        }
    end
    helper.addon("Core.lua", env)

    assert(C.VERSION == 1)
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("Addon 0.0.8-nightly.123.2", 1, true))
    assert(logs[1]:find("desktop/bridge unknown", 1, true))
    assert(not logs[1]:find("version mismatch", 1, true))
    C.db = { drafts = {} }
    C.Acknowledge = function() end
    GetTime = function()
        return 1
    end
    C.ReceiveSnapshot({
        v = 1,
        session = C.session,
        rev = 1,
        connected = true,
        bridgeVersion = "0.0.7",
    })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("desktop/bridge 0.0.7", 1, true))
    assert(logs[1]:find("version mismatch", 1, true))
    C.ReceiveSnapshot({
        v = 1,
        session = C.session,
        rev = 2,
        connected = true,
        bridgeVersion = C.addonVersion,
    })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(not logs[1]:find("version mismatch", 1, true))
    C.ReceiveSnapshot({ v = 1, session = C.session, rev = 3, connected = true })
    logs = {}
    SlashCmdList.WISPAI("diag")
    assert(logs[1]:find("desktop/bridge unknown", 1, true))
end)
