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
local reloadNoticeShown = false
local function versionParts(version)
    local major, minor, patch = tostring(version or ""):match("^(%d+)%.(%d+)%.(%d+)$")
    if major then
        return { tonumber(major), tonumber(minor), tonumber(patch) }
    end
end
-- True when Desktop installed a newer addon than the one this UI session loaded.
local function reloadNeeded()
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
    if reloadNoticeShown or not reloadNeeded() then
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
    elseif event == "PLAYER_LOGIN" then
        ns.UI.BuildUI()
        if ns.Inline.InitInline then
            ns.Inline.InitInline()
        end
        if ns.Panels.InitPanels then
            ns.Panels.InitPanels()
        end
        if ns.Advice.InitAdvice then
            ns.Advice.InitAdvice()
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
    if message == "reconnect" then
        ns.Transport.Send({ type = "hello", chat = ns.active })
        return
    end
    ns.UI.SetMinimized(not ns.db.minimized)
end
