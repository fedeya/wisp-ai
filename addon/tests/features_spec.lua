local helper = require("addon.tests.support")

it("reads feature flags from the latest bridge snapshot", function()
    local env = helper.env()
    setfenv(1, env)
    do
        SlashCmdList = {}
        ns = helper.namespace({ slot = 1 })
        function time()
            return 1
        end
        function CreateFrame()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        DEFAULT_CHAT_FRAME = { AddMessage = function() end }
        C_AddOns = {
            GetAddOnMetadata = function()
                return "1.0.0"
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
    local function receive(features)
        rev = rev + 1
        ns.Chat.ReceiveSnapshot({
            v = 1,
            session = ns.session,
            rev = rev,
            connected = true,
            features = features,
        })
    end

    assert(ns.Core.FeatureEnabled("new_panel") == false)
    receive({ new_panel = true, dev_only = false })
    assert(ns.Core.FeatureEnabled("new_panel") == true)
    assert(ns.Core.FeatureEnabled("dev_only") == false)
    assert(ns.Core.FeatureEnabled("missing") == false)
    receive({ new_panel = false })
    assert(ns.Core.FeatureEnabled("new_panel") == false)
    -- A bridge without flags (an older desktop) turns every flag off.
    receive({ new_panel = true })
    receive(nil)
    assert(ns.Core.FeatureEnabled("new_panel") == false)
end)

it("tells listeners only when a feature flag turns on or off", function()
    local env = helper.env()
    setfenv(1, env)
    do
        SlashCmdList = {}
        ns = helper.namespace({ slot = 1 })
        function time()
            return 1
        end
        function CreateFrame()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        DEFAULT_CHAT_FRAME = { AddMessage = function() end }
        C_AddOns = {
            GetAddOnMetadata = function()
                return "1.0.0"
            end,
        }
    end
    helper.addon("Core.lua", env)
    local seen = {}
    ns.Core.OnFeaturesChanged(function()
        seen[#seen + 1] = ns.Core.FeatureEnabled("new_panel")
    end)

    -- All off, as before the first snapshot: nothing changed.
    ns.Core.SetFeatures({ new_panel = false })
    assert(#seen == 0)
    ns.Core.SetFeatures({ new_panel = true, dev_only = false })
    assert(#seen == 1 and seen[1] == true)
    ns.Core.SetFeatures({ new_panel = true })
    assert(#seen == 1)
    ns.Core.SetFeatures({ new_panel = true, dev_only = true })
    assert(#seen == 2 and seen[2] == true)
    ns.Core.SetFeatures(nil)
    assert(#seen == 3 and seen[3] == false)
end)
