local addonName, ns = ...
WispAI = {
    ActivateInline = function(...)
        return ns.Inline.ActivateInline(...)
    end,
}
ns.VERSION = 1
local metadata = C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata
ns.addonVersion = type(metadata) == "function" and metadata(addonName, "Version") or "unknown"
ns.SLOTS = 1024
ns.session = tostring(time()) .. "-" .. tostring(math.random(100000, 999999))
ns.chats, ns.requestsDone = {}, {}
ns.pendingMessages, ns.pendingChats = {}, {}
ns.deletedChats = {}
ns.capabilityPending = {}
ns.workStarted = {}
ns.responseTiming = {}
ns.connected, ns.rev = false, 0
function ns.Core.Log(text)
    DEFAULT_CHAT_FRAME:AddMessage("|cff77dbc6Wisp:|r " .. text)
end
-- Give the bridge this long after login before asking for Wisp Desktop.
local CONNECT_GRACE_SECONDS = 15
local connectingUntil = 0
--- Locale key for a connection that is being (re)established, or nil.
--- Login waits a short grace period; a restarted bridge stays "reconnecting"
--- until its first snapshot is applied.
function ns.Core.ConnectingStatus()
    if ns.connected then
        return nil
    end
    if ns.reconnecting then
        return "status.reconnecting"
    end
    if GetTime() < connectingUntil then
        return "status.connecting"
    end
end
local reloadNoticeShown = false
local function versionParts(version)
    local major, minor, patch = tostring(version or ""):match("^(%d+)%.(%d+)%.(%d+)$")
    if major then
        return { tonumber(major), tonumber(minor), tonumber(patch) }
    end
end
-- True when Desktop installed a newer addon than the one this UI session loaded.
function ns.Core.ReloadNeeded()
    local expected = ns.expectedAddonVersion
    if
        type(expected) ~= "string"
        or type(ns.addonVersion) ~= "string"
        or ns.addonVersion == "unknown"
    then
        return false
    end
    local loaded, installed = versionParts(ns.addonVersion), versionParts(expected)
    if not loaded or not installed then
        return expected ~= ns.addonVersion
    end
    for index = 1, 3 do
        if installed[index] ~= loaded[index] then
            return installed[index] > loaded[index]
        end
    end
    return false
end
-- Prints the /reload hint at most once per UI session; /reload resets it.
function ns.Core.NotifyAddonUpdate()
    if reloadNoticeShown or not ns.Core.ReloadNeeded() then
        return
    end
    reloadNoticeShown = true
    ns.Core.Log(ns.LocaleText("notice.addonUpdated", {
        installed = ns.expectedAddonVersion,
        loaded = ns.addonVersion,
    }))
end
local appUpdateNoticed
-- Announces a Desktop app update once per version and UI session.
function ns.Core.NotifyAppUpdate(version)
    if type(version) ~= "string" or version == "" or version == appUpdateNoticed then
        return
    end
    appUpdateNoticed = version
    ns.Core.Log(ns.LocaleText("notice.appUpdateAvailable", { version = version }))
end
-- Names of the feature flags that are on, and who wants to hear when they change.
local features = {}
local featureListeners = {}
local function sameFeatures(left, right)
    for name in pairs(left) do
        if not right[name] then
            return false
        end
    end
    for name in pairs(right) do
        if not left[name] then
            return false
        end
    end
    return true
end
-- Calls `listener()` after a snapshot turns any feature flag on or off. Every flag
-- is off before the first snapshot, so code that decides at login should also
-- listen, then read ns.Core.FeatureEnabled again.
function ns.Core.OnFeaturesChanged(listener)
    featureListeners[#featureListeners + 1] = listener
end
-- Keeps the feature flags the bridge resolved, by name; a snapshot replaces them all.
function ns.Core.SetFeatures(values)
    local enabled = {}
    if type(values) == "table" then
        for name, value in pairs(values) do
            if value == true then
                enabled[name] = true
            end
        end
    end
    if sameFeatures(features, enabled) then
        return
    end
    features = enabled
    for _, listener in ipairs(featureListeners) do
        listener()
    end
end
-- Whether the bridge turned a feature flag on. Every flag is off until the first snapshot.
function ns.Core.FeatureEnabled(name)
    return features[name] == true
end
function WispAI_Receive(json)
    local ok, data = pcall(C_EncodingUtil.DeserializeJSON, json)
    if ok then
        ns.Chat.ReceiveSnapshot(data)
    end
end
local events = CreateFrame("Frame")
events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_LOGIN")
events:SetScript("OnEvent", function(_, event, name)
    if event == "ADDON_LOADED" and name == "WispAI" then
        WispAIDB = WispAIDB or {}
        ns.db = WispAIDB
        ns.db.drafts = ns.db.drafts or {}
        if ns.db.sidebar == nil then
            ns.db.sidebar = true
        end
        if ns.db.sound == nil then
            ns.db.sound = true
        end
        if ns.db.showTools == nil then
            ns.db.showTools = true
        end
        ns.active = ns.db.activeChat
        -- Before PLAYER_LOGIN, when Polestar restores its tabs.
        if ns.Integrations.RestorePolestarGuides then
            local ok, result, failures = pcall(ns.Integrations.RestorePolestarGuides)
            if not ok then
                failures = { tostring(result) }
            end
            for _, failure in ipairs(failures or {}) do
                ns.Core.Log("Could not restore a Polestar guide (" .. failure .. ").")
            end
        end
    elseif event == "PLAYER_LOGIN" then
        connectingUntil = GetTime() + CONNECT_GRACE_SECONDS
        C_Timer.After(CONNECT_GRACE_SECONDS, function()
            if ns.UI.Refresh then
                ns.UI.Refresh()
            end
        end)
        ns.UI.BuildUI()
        if ns.UI.GameOptions.Register then
            ns.UI.GameOptions.Register()
        end
        if ns.Inline.InitInline then
            ns.Inline.InitInline()
        end
        if ns.Panels.InitPanels then
            ns.Panels.InitPanels()
        end
        if ns.Advice.InitAdvice then
            ns.Advice.InitAdvice()
        end
        if ns.Moments.InitMoments then
            ns.Moments.InitMoments()
        end
        ns.Transport.StartTransport()
        ns.Transport.Send({ type = "hello", chat = ns.active, context = ns.Character.CaptureTurn() })
    end
end)
SLASH_WISPAI1 = "/wisp"
SLASH_WISPAI2 = "/wispai"
SlashCmdList.WISPAI = function(message)
    if message == "ask" then
        if ns.Inline.OpenInline then
            ns.Inline.OpenInline()
        end
        return
    end
    if message == "diag" then
        local stats = ns.transportStats or {}
        local mismatch = ns.expectedAddonVersion
            and ns.addonVersion ~= "unknown"
            and ns.expectedAddonVersion ~= ns.addonVersion
        ns.Core.Log(
            "Addon "
                .. ns.addonVersion
                .. ", desktop/bridge "
                .. (ns.bridgeVersion or "unknown")
                .. (mismatch and " (version mismatch; update the addon and /reload)" or "")
        )
        ns.Core.Log(
            "Slots "
                .. ns.slot
                .. "/"
                .. ns.SLOTS
                .. ", unchanged reads "
                .. (stats.unchanged or 0)
                .. ", revision "
                .. ns.rev
                .. ", "
                .. (ns.connected and "connected" or "waiting for bridge")
        )
        return
    end
    if message == "settings" then
        ns.UI.ShowSettings("general")
        return
    end
    if message == "reconnect" then
        ns.Transport.Send({ type = "hello", chat = ns.active })
        return
    end
    ns.UI.SetMinimized(not ns.db.minimized)
end
