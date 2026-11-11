local _, ns = ...
local label, box, button = ns.UI.Widgets.Label, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD = ns.UI.Widgets.GOLD
local refreshReferences = ns.UI.MessageFormat.RefreshReferences
local frame, header, body, chatPanel, mini, gear, resize, settings
local rendering = false

function ns.UI.SaveWindowPosition(minimized)
    local point, _, relativePoint, x, y = frame:GetPoint()
    local position = { point = point, relativePoint = relativePoint, x = x, y = y }
    if minimized then
        ns.db.minimizedPosition = position
    else
        ns.db.expandedPosition = position
    end
end
local function restorePosition(minimized)
    local p = (minimized and ns.db.minimizedPosition)
        or ns.db.expandedPosition
        or { point = ns.db.point or "CENTER", x = ns.db.x or 0, y = ns.db.y or 0 }
    frame:ClearAllPoints()
    frame:SetPoint(p.point, UIParent, p.relativePoint or p.point, p.x or 0, p.y or 0)
end

local function layout()
    local expanded = not ns.db.minimized
    gear:SetShown(expanded)
    resize:SetShown(expanded)
    local width = ns.UI.Sidebar.Layout()
    local titleAnchor = expanded and gear or mini
    if header.titleAnchor ~= titleAnchor then
        header.titleAnchor = titleAnchor
        header.title:ClearAllPoints()
        header.title:SetPoint("LEFT", header.logo, "RIGHT", 6, 0)
        header.title:SetPoint("RIGHT", titleAnchor, "LEFT", -8, 0)
    end
    if chatPanel._sidebarWidth ~= width then
        chatPanel._sidebarWidth = width
        chatPanel:ClearAllPoints()
        chatPanel:SetPoint("TOPLEFT", body, "TOPLEFT", width, 0)
        chatPanel:SetPoint("BOTTOMRIGHT", body, "BOTTOMRIGHT", 0, 0)
    end
end

function ns.UI.SetMinimized(value)
    if not frame or value == ns.db.minimized then
        return
    end
    ns.UI.SaveWindowPosition(ns.db.minimized)
    if value and not ns.db.minimizedPosition then
        local left, top = frame:GetLeft(), frame:GetTop()
        if left and top then
            ns.db.minimizedPosition =
                { point = "TOPLEFT", relativePoint = "BOTTOMLEFT", x = left, y = top }
        end
    end
    ns.db.minimized = value
    body:SetShown(not value)
    settings:Hide()
    if value then
        ns.db.expandedWidth, ns.db.expandedHeight = frame:GetWidth(), frame:GetHeight()
        if frame.SetResizeBounds then
            frame:SetResizeBounds(220, 36, 1000, 900)
        end
        frame:SetSize(220, 36)
        mini:SetText("+")
    else
        if frame.SetResizeBounds then
            frame:SetResizeBounds(430, 320, 1000, 900)
        end
        frame:SetSize(ns.db.expandedWidth or 610, ns.db.expandedHeight or 490)
        mini:SetText("-")
        ns.unread = false
    end
    restorePosition(value)
    ns.UI.Refresh()
end

function ns.UI.Refresh()
    if not frame or rendering then
        return
    end
    rendering = true
    local chat = ns.Chat.Current()
    ns.UI.ConversationStatus.Refresh(chat)
    ns.UI.Activity.Refresh(chat)
    ns.UI.Composer.Refresh(chat)
    layout()
    ns.UI.Sidebar.Refresh()
    ns.UI.Transcript.Refresh(chat)
    rendering = false
    if ns.Inline.RefreshInline then
        ns.Inline.RefreshInline()
    end
end

function ns.UI.BuildUI()
    refreshReferences()
    frame = CreateFrame("Frame", "WispAIWindow", UIParent, "BackdropTemplate")
    frame:SetSize(ns.db.expandedWidth or 610, ns.db.expandedHeight or 490)
    restorePosition(false)
    frame:SetClampedToScreen(true)
    frame:SetMovable(true)
    frame:EnableMouse(true)
    frame:SetFrameStrata("DIALOG")
    frame:SetResizable(true)
    if frame.SetResizeBounds then
        frame:SetResizeBounds(430, 320, 1000, 900)
    end
    box(frame, { 0.075, 0.065, 0.05, 0.97 }, 16)
    header = CreateFrame("Frame", nil, frame)
    header:SetPoint("TOPLEFT", 5, -4)
    header:SetPoint("TOPRIGHT", -5, -4)
    header:SetHeight(30)
    header:EnableMouse(true)
    header:RegisterForDrag("LeftButton")
    header:SetScript("OnDragStart", function()
        frame:StartMoving()
    end)
    header:SetScript("OnDragStop", function()
        frame:StopMovingOrSizing()
        ns.UI.SaveWindowPosition(ns.db.minimized)
    end)
    local logo = header:CreateTexture(nil, "ARTWORK")
    header.logo = logo
    logo:SetSize(24, 24)
    logo:SetPoint("LEFT", 4, 0)
    logo:SetTexture("Interface\\AddOns\\WispAI\\Textures\\Wisp.tga")
    header.title = label(header, "Wisp AI", GOLD)
    header.title:SetPoint("LEFT", logo, "RIGHT", 6, 0)
    mini = button(header, "-", 25, function()
        ns.UI.SetMinimized(not ns.db.minimized)
    end)
    mini:SetPoint("RIGHT", -3, 0)
    gear = CreateFrame("Button", "WispAISettingsButton", header)
    gear:SetSize(24, 24)
    gear:SetPoint("RIGHT", mini, "LEFT", -4, 0)
    gear:SetNormalTexture("Interface\\AddOns\\WispAI\\Textures\\Gear.tga")
    gear:SetHighlightTexture("Interface\\Buttons\\ButtonHilight-Square", "ADD")
    gear:SetScript("OnClick", function()
        settings:SetShown(not settings:IsShown())
    end)
    gear:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
        GameTooltip:SetText("Settings")
        GameTooltip:Show()
    end)
    gear:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    header.title:SetWordWrap(false)
    body = CreateFrame("Frame", nil, frame)
    body:SetPoint("TOPLEFT", 6, -37)
    body:SetPoint("BOTTOMRIGHT", -6, 5)
    ns.UI.Sidebar.Build(body)
    chatPanel = CreateFrame("Frame", nil, body)
    ns.UI.ConversationStatus.Build(chatPanel)
    ns.UI.Transcript.Build(chatPanel, header)
    ns.UI.Composer.Build(chatPanel, ns.UI.Transcript.SetBottomInset)
    frame:SetScript("OnUpdate", ns.UI.Activity.Tick)
    resize = CreateFrame("Button", nil, frame)
    resize:SetSize(18, 18)
    resize:SetPoint("BOTTOMRIGHT")
    resize:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
    resize:SetScript("OnMouseDown", function()
        if not ns.db.minimized then
            frame:StartSizing("BOTTOMRIGHT")
        end
    end)
    resize:SetScript("OnMouseUp", function()
        frame:StopMovingOrSizing()
        if not ns.db.minimized then
            ns.db.expandedWidth, ns.db.expandedHeight = frame:GetWidth(), frame:GetHeight()
            ns.UI.SaveWindowPosition(false)
        end
        ns.UI.Refresh()
    end)
    settings = ns.UI.SettingsPanel.Build(frame, body)
    local itemEvents = CreateFrame("Frame")
    itemEvents:RegisterEvent("GET_ITEM_INFO_RECEIVED")
    itemEvents:RegisterEvent("QUEST_LOG_UPDATE")
    itemEvents:RegisterEvent("UPDATE_MACROS")
    itemEvents:SetScript("OnEvent", function(_, event)
        if event == "QUEST_LOG_UPDATE" and not refreshReferences() then
            return
        end
        ns.itemRevision = ns.itemRevision + 1
        ns.UI.Refresh()
    end)
    frame:EnableKeyboard(true)
    frame:SetPropagateKeyboardInput(true)
    frame:SetScript("OnKeyDown", function(self, key)
        if key == "ESCAPE" and ns.Inline.CloseInline and ns.Inline.CloseInline() then
            self:SetPropagateKeyboardInput(false)
        elseif key == "ESCAPE" and not ns.db.minimized then
            ns.draft:ClearFocus()
            ns.UI.SetMinimized(true)
            self:SetPropagateKeyboardInput(false)
        else
            self:SetPropagateKeyboardInput(true)
        end
    end)
    if ns.db.minimized then
        ns.db.minimized = false
        ns.UI.SetMinimized(true)
    end
    ns.UI.Refresh()
    C_Timer.After(0, ns.UI.Refresh)
end
