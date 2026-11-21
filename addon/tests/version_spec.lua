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

it("prints the /reload hint once when Desktop installed a newer addon", function()
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
            GetAddOnMetadata = function()
                return "1.2.9"
            end,
        }
    end
    helper.addon("Core.lua", env)
    ns.db = { drafts = {} }
    ns.Transport.Acknowledge = function() end
    GetTime = function()
        return 1
    end
    local rev = 0
    local function receive(expected)
        rev = rev + 1
        ns.Chat.ReceiveSnapshot({
            v = 1,
            session = ns.session,
            rev = rev,
            connected = true,
            expectedAddonVersion = expected,
        })
    end

    receive(nil)
    receive("1.2.9")
    receive("1.1.40")
    assert(#logs == 0)
    receive("1.2.10")
    assert(#logs == 1)
    assert(logs[1]:find("Wisp 1.2.10 is installed (loaded 1.2.9)", 1, true))
    assert(logs[1]:find("/reload", 1, true))
    receive("1.2.10")
    receive("1.3.0")
    assert(#logs == 1)
end)

it("announces a Desktop app update once per version", function()
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
            GetAddOnMetadata = function()
                return "1.2.9"
            end,
        }
    end
    helper.addon("Core.lua", env)
    ns.db = { drafts = {} }
    ns.Transport.Acknowledge = function() end
    GetTime = function()
        return 1
    end
    local rev = 0
    local function receive(version)
        rev = rev + 1
        ns.Chat.ReceiveSnapshot({
            v = 1,
            session = ns.session,
            rev = rev,
            connected = true,
            appUpdateVersion = version,
        })
    end

    receive(nil)
    receive("")
    assert(#logs == 0)
    receive("0.0.9")
    assert(#logs == 1)
    assert(logs[1]:find("Wisp 0.0.9 is available. Open the Wisp app to install it.", 1, true))
    receive("0.0.9")
    receive(nil)
    receive("0.0.9")
    assert(#logs == 1)
    receive("0.0.10")
    assert(#logs == 2)
    assert(logs[2]:find("Wisp 0.0.10", 1, true))
end)
