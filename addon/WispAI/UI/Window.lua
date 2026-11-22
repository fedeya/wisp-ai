local _, ns = ...
local L = ns.L
local COLORS = ns.UI.Widgets.COLORS
local label, box = ns.UI.Widgets.Label, ns.UI.Widgets.Box
local TEXT = ns.UI.Widgets.TEXT
local refreshReferences = ns.UI.MessageFormat.RefreshReferences
local markItemLoaded = ns.UI.MessageFormat.MarkItemLoaded
local frame, header, body, chatPanel, mini, gear, resize, settings
local rendering = false
-- Minimized, the window is its title bar alone: the bar's 36 units and the
-- frame's top and bottom hairlines, so restoring keeps the bar where it was.
local MINI_WIDTH, MINI_HEIGHT = 240, 38
-- Item and macro data, and quest log changes, are handled in batches.
local ITEM_BATCH_SECONDS, QUEST_BATCH_SECONDS = 0.2, 0.4

--- Window control: diagonal arrows pointing in to minimize the window to its
--- bar, and out to restore it, as floating chat panels do.
local function windowButton(parent)
    local b = CreateFrame("Button", "WispAIMinimizeButton", parent)
    b:SetSize(24, 24)
    ns.UI.Widgets.Hover(b)
    local icons = {}
    local function icon(file)
        local t = b:CreateTexture(nil, "ARTWORK")
        t:SetTexture(ns.UI.Widgets.TEXTURES .. file)
        t:SetSize(14, 14)
        t:SetPoint("CENTER")
        t:SetVertexColor(unpack(ns.UI.Widgets.MUTED))
        icons[#icons + 1] = t
        return t
    end
    b.minimize = icon("Collapse.tga")
    b.restore = icon("Expand.tga")
    b.restore:Hide()
    local function paint(color)
        for _, t in ipairs(icons) do
            t:SetVertexColor(unpack(color))
        end
    end
    b:SetScript("OnEnter", function(self)
        paint(TEXT)
        GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
        GameTooltip:SetText(ns.db.minimized and L["window.restore"] or L["window.minimize"])
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function()
        paint(ns.UI.Widgets.MUTED)
        GameTooltip:Hide()
    end)
    return b
end

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
    header.rule:SetShown(expanded)
    -- The sidebar toggle leads the title bar; minimized, the logo takes its place.
    header.fold:SetShown(expanded)
    if header.logoAnchor ~= expanded then
        header.logoAnchor = expanded
        header.logo:ClearAllPoints()
        if expanded then
            header.logo:SetPoint("LEFT", header.fold, "RIGHT", 6, 0)
        else
            header.logo:SetPoint("LEFT", 6, 0)
        end
    end
    gear.icon:SetVertexColor(
        unpack(settings and settings:IsShown() and ns.UI.Widgets.ACCENT or ns.UI.Widgets.MUTED)
    )
    local width = ns.UI.Sidebar.Layout()
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
            frame:SetResizeBounds(MINI_WIDTH, MINI_HEIGHT, 1000, 900)
        end
        frame:SetSize(MINI_WIDTH, MINI_HEIGHT)
    else
        if frame.SetResizeBounds then
            frame:SetResizeBounds(520, 360, 1100, 900)
        end
        frame:SetSize(ns.db.expandedWidth or 700, ns.db.expandedHeight or 520)
        ns.unread = false
    end
    mini.minimize:SetShown(not value)
    mini.restore:SetShown(value)
    restorePosition(value)
    ns.UI.Refresh()
end

--- Opens Settings as a page over the conversation panel. `page` is "general",
--- "memory" or "integrations"; nil closes it. Settings always reopens on its
--- main page, so navigating away never leaves a subpage stuck on screen.
function ns.UI.ShowSettings(page)
    if not frame then
        return
    end
    ns.UI.SettingsPanel.ResetPages()
    if not page then
        if settings:IsShown() then
            settings:Hide()
            ns.UI.Refresh()
        end
        return
    end
    if ns.db.minimized then
        ns.UI.SetMinimized(false)
    end
    settings:Show()
    if page == "memory" then
        ns.UI.Memory.Show()
    elseif page == "integrations" then
        ns.UI.Capabilities.Show()
    end
    ns.UI.Refresh()
end

--- True while Settings covers the conversation panel.
function ns.UI.SettingsShown()
    return settings ~= nil and settings:IsShown()
end

--- Escape steps back one level: a subpage to its page, a page to the chat.
--- Returns false when already on the chat, where Escape minimizes instead.
function ns.UI.GoBack()
    if ns.UI.SettingsShown() then
        if not ns.UI.SettingsPanel.CloseSubpage() then
            ns.UI.ShowSettings(nil)
        end
        return true
    end
    if ns.UI.Routines.IsShown() then
        ns.UI.Routines.Back()
        return true
    end
    return false
end

function ns.UI.Refresh(preserveScrollForChat)
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
    ns.UI.Routines.Layout()
    ns.UI.Transcript.Refresh(chat, preserveScrollForChat)
    rendering = false
    if ns.Inline.RefreshInline then
        ns.Inline.RefreshInline(preserveScrollForChat)
    end
end

function ns.UI.BuildUI()
    ns.UI.Widgets.ApplyFonts(ns.ActiveLocale())
    refreshReferences()
    frame = CreateFrame("Frame", "WispAIWindow", UIParent, "BackdropTemplate")
    frame:SetSize(ns.db.expandedWidth or 700, ns.db.expandedHeight or 520)
    restorePosition(false)
    frame:SetClampedToScreen(true)
    frame:SetMovable(true)
    frame:EnableMouse(true)
    -- Same layer as the bags and character panels, raised on click, so the
    -- world map and other full-screen windows cover it instead of the reverse.
    frame:SetFrameStrata("MEDIUM")
    frame:SetToplevel(true)
    frame:SetResizable(true)
    if frame.SetResizeBounds then
        frame:SetResizeBounds(520, 360, 1100, 900)
    end
    box(frame, COLORS.window, COLORS.line)
    header = CreateFrame("Frame", "WispAIHeader", frame)
    header:SetPoint("TOPLEFT", 5, -4)
    header:SetPoint("TOPRIGHT", -5, -4)
    header:SetHeight(30)
    header:EnableMouse(true)
    header:RegisterForDrag("LeftButton")
    header:SetScript("OnDragStart", function()
        header.dragged = true
        frame:StartMoving()
    end)
    header:SetScript("OnDragStop", function()
        frame:StopMovingOrSizing()
        ns.UI.SaveWindowPosition(ns.db.minimized)
    end)
    -- Minimized, a click anywhere on the bar restores the window; a drag still
    -- only moves it.
    header:SetScript("OnMouseDown", function()
        header.dragged = false
    end)
    header:SetScript("OnMouseUp", function(_, button)
        if button == "LeftButton" and not header.dragged and ns.db.minimized then
            ns.UI.SetMinimized(false)
        end
    end)
    -- Sidebar toggle, far left of the title bar, as in Claude and ChatGPT.
    local fold = CreateFrame("Button", "WispAISidebarToggle", header)
    header.fold = fold
    fold:SetSize(24, 24)
    fold:SetPoint("LEFT", 4, 0)
    fold.icon = fold:CreateTexture(nil, "ARTWORK")
    fold.icon:SetTexture(ns.UI.Widgets.TEXTURES .. "Sidebar.tga")
    fold.icon:SetSize(15, 15)
    fold.icon:SetPoint("CENTER")
    fold.icon:SetVertexColor(unpack(ns.UI.Widgets.MUTED))
    ns.UI.Widgets.Hover(fold)
    fold:SetScript("OnClick", function()
        ns.UI.Sidebar.Toggle()
    end)
    fold:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
        GameTooltip:SetText(ns.db.sidebar and L["sidebar.hide"] or L["sidebar.show"])
        GameTooltip:Show()
    end)
    fold:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    local logo = header:CreateTexture(nil, "ARTWORK")
    header.logo = logo
    logo:SetSize(20, 20)
    logo:SetPoint("LEFT", 6, 0)
    logo:SetTexture("Interface\\AddOns\\WispAI\\Textures\\Wisp.tga")
    header.title = label(header, "Wisp AI", TEXT, ns.UI.Widgets.FONTS.title)
    -- "Wisp AI" in both states; minimized, the reply's state follows it.
    header.title:SetPoint("LEFT", logo, "RIGHT", 6, 0)
    -- The header is a bar of its own: the sidebar's surface with a firm bottom edge.
    local bar = frame:CreateTexture(nil, "BACKGROUND", nil, 1)
    bar:SetPoint("TOPLEFT", 1, -1)
    bar:SetPoint("TOPRIGHT", -1, -1)
    bar:SetHeight(36)
    bar:SetColorTexture(unpack(COLORS.sidebar))
    local rule = header:CreateTexture(nil, "ARTWORK")
    rule:SetPoint("TOPLEFT", bar, "BOTTOMLEFT", 0, 0)
    rule:SetPoint("TOPRIGHT", bar, "BOTTOMRIGHT", 0, 0)
    rule:SetHeight(ns.UI.Widgets.OnePixel(rule))
    ns.UI.Widgets.Tint(rule, COLORS.lineStrong)
    header.rule = rule
    mini = windowButton(header)
    mini:SetScript("OnClick", function()
        ns.UI.SetMinimized(not ns.db.minimized)
    end)
    mini:SetPoint("RIGHT", -3, 0)
    header.mini = mini
    header.title:SetWordWrap(false)
    body = CreateFrame("Frame", nil, frame)
    body:SetPoint("TOPLEFT", 1, -38)
    body:SetPoint("BOTTOMRIGHT", -1, 1)
    ns.UI.Sidebar.Build(body)
    gear = CreateFrame("Button", "WispAISettingsButton", ns.UI.Sidebar.Footer())
    gear:SetSize(22, 22)
    gear:SetPoint("RIGHT", -5, 0)
    gear.icon = gear:CreateTexture(nil, "ARTWORK")
    gear.icon:SetTexture("Interface\\AddOns\\WispAI\\Textures\\Settings.tga")
    gear.icon:SetSize(14, 14)
    gear.icon:SetPoint("CENTER")
    gear.icon:SetVertexColor(unpack(ns.UI.Widgets.MUTED))
    ns.UI.Widgets.Hover(gear)
    gear:SetScript("OnClick", function()
        ns.UI.ShowSettings(not settings:IsShown() and "general" or nil)
    end)
    gear:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(L["settings.title"])
        GameTooltip:Show()
    end)
    gear:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    chatPanel = CreateFrame("Frame", nil, body)
    ns.UI.ConversationStatus.Build(chatPanel, header)
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
    ns.UI.Routines.Build(frame, chatPanel)
    settings = ns.UI.SettingsPanel.Build(frame, chatPanel)
    -- Opening bags or the quest log fires these events in bursts. A burst waits
    -- for one timer, then redraws only a chat on screen that shows one of the
    -- changed items or a macro. Quest links read the stored quest on hover, so
    -- quest updates only store it.
    local loadedItems, macrosChanged = {}, false
    local itemsPending, questsPending = false, false
    local function shows(chat, changed)
        for _, message in ipairs(chat and chat.messages or {}) do
            if type(message.references) == "table" then
                for _, ref in pairs(message.references) do
                    if type(ref) == "table" and changed(ref) then
                        return true
                    end
                end
            end
        end
        return false
    end
    local function flushItems()
        itemsPending = false
        local items, macros = loadedItems, macrosChanged
        loadedItems, macrosChanged = {}, false
        for id in pairs(items) do
            markItemLoaded(id)
        end
        local function changed(ref)
            return ref.kind == "item" and items[tonumber(ref.id)] == true
                or ref.kind == "macro" and macros
        end
        -- Restoring a minimized window redraws it, and the inline panel
        -- redraws only while it is open.
        if not ns.db.minimized and shows(ns.Chat.Current(), changed) then
            ns.UI.Refresh()
        elseif
            ns.Inline.RefreshInline
            and ns.Inline.InlineCurrent
            and shows(ns.Inline.InlineCurrent(), changed)
        then
            ns.Inline.RefreshInline()
        end
    end
    local function flushQuests()
        questsPending = false
        refreshReferences()
    end
    local itemEvents = CreateFrame("Frame")
    itemEvents:RegisterEvent("GET_ITEM_INFO_RECEIVED")
    itemEvents:RegisterEvent("QUEST_LOG_UPDATE")
    itemEvents:RegisterEvent("UPDATE_MACROS")
    itemEvents:SetScript("OnEvent", function(_, event, itemID)
        if event == "QUEST_LOG_UPDATE" then
            if not questsPending then
                questsPending = true
                C_Timer.After(QUEST_BATCH_SECONDS, flushQuests)
            end
            return
        end
        if event == "GET_ITEM_INFO_RECEIVED" then
            local id = tonumber(itemID)
            if not id then
                return
            end
            loadedItems[id] = true
        else
            macrosChanged = true
        end
        if not itemsPending then
            itemsPending = true
            C_Timer.After(ITEM_BATCH_SECONDS, flushItems)
        end
    end)
    frame:EnableKeyboard(true)
    frame:SetPropagateKeyboardInput(true)
    frame:SetScript("OnKeyDown", function(self, key)
        if key == "ESCAPE" and ns.Inline.CloseInline and ns.Inline.CloseInline() then
            self:SetPropagateKeyboardInput(false)
        elseif key == "ESCAPE" and not ns.db.minimized then
            ns.draft:ClearFocus()
            if not ns.UI.GoBack() then
                ns.UI.SetMinimized(true)
            end
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
