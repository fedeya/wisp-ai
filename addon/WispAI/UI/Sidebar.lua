local _, ns = ...
local L = ns.L
local widgets = ns.UI.Widgets
local COLORS, FONTS = widgets.COLORS, widgets.FONTS
local label, setText = widgets.Label, widgets.SetText
local TEXT, ACCENT = widgets.TEXT, widgets.ACCENT
-- The sidebar's width is the player's to drag between MIN_WIDTH and MAX_WIDTH,
-- always leaving the conversation at least MIN_CHAT_WIDTH.
local DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, MIN_CHAT_WIDTH = 190, 150, 320, 300
local CHAT_ROW, ROW_GAP = 26, 2
local NAV_ROW, FOOTER_HEIGHT = 30, 46
local sidebar, nav, footer
local sessionContent, sessionScroll
local sessionButtons, dayHeaders = {}, {}
-- Day headings sit in the list, so they scroll with the rows they head. The
-- first takes the place of a section caption; later ones leave a gap above.
local HEADER_TOP, HEADER_HEIGHT, HEADER_GAP = 6, 18, 12
local newChatTab, routinesTab

function ns.UI.RequestDeleteChat(id)
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            StaticPopup_Show("WISPAI_DELETE_CHAT", chat.title, nil, id)
            return
        end
    end
end

-- The character's name, and for the avatar's tooltip its class, level and the
-- connection state.
local function characterLine()
    local name = UnitName and UnitName("player") or nil
    local className = UnitClass and UnitClass("player") or nil
    local level = UnitLevel and UnitLevel("player") or nil
    local connecting = ns.Core.ConnectingStatus and ns.Core.ConnectingStatus()
    local state = ns.Transport.needsDesktopSetup and L["status.setupRequired"]
        or (ns.connected and L["status.connected"])
        or (connecting and L[connecting])
        or L["status.offline"]
    local classLevel = className and level and (className .. " " .. level) or ""
    return name or "Wisp", classLevel, state
end

-- Returns the sidebar width so the window can anchor the conversation panel.
-- Collapsed, the sidebar is hidden entirely; its toggle lives in the title bar.
local function expandedWidth()
    local available = sidebar:GetParent():GetWidth() or 0
    local most = MAX_WIDTH
    if available > 0 then
        most = math.max(MIN_WIDTH, math.min(MAX_WIDTH, available - MIN_CHAT_WIDTH))
    end
    return math.floor(math.max(MIN_WIDTH, math.min(most, ns.db.sidebarWidth or DEFAULT_WIDTH)))
end

function ns.UI.Sidebar.Layout()
    local expanded = ns.db.sidebar == true
    sidebar:SetShown(expanded)
    local width = expanded and expandedWidth() or 0
    sidebar:SetWidth(math.max(1, width))
    sessionContent:SetWidth(math.max(1, width - 12))
    return width
end

--- Shows or hides the sidebar; the title bar's sidebar button calls it.
function ns.UI.Sidebar.Toggle()
    ns.db.sidebar = not ns.db.sidebar
    ns.UI.Refresh()
end

-- A conversation row's right side: the delete X shows on the selected row and
-- while the row is hovered; otherwise the activity mark, if any. The title
-- makes room only for what is shown.
local function paintRowEnd(b)
    local showDelete = b.selected == true or b.hovered == true
    b.delete:SetShown(showDelete)
    b.mark:SetShown(b.marked and not showDelete)
    local inset = showDelete and -26 or (b.marked and -20 or -10)
    if b.labelInset ~= inset then
        b.labelInset = inset
        b.label:SetPoint("RIGHT", inset, 0)
    end
end

local function setHover(b, hovered)
    b.hovered = hovered
    paintRowEnd(b)
end

local function openRowMenu(b)
    if not (MenuUtil and MenuUtil.CreateContextMenu) then
        ns.UI.RequestDeleteChat(b.chatId)
        return
    end
    MenuUtil.CreateContextMenu(b, function(_, root)
        root:CreateButton(L["sidebar.deleteConversation"], function()
            ns.UI.RequestDeleteChat(b.chatId)
        end)
    end)
end

local function makeRow()
    local b = widgets.NavItem(sessionContent, "", CHAT_ROW)
    b.marked = false
    -- Rows span the list, so the title can run to the sidebar's edge.
    b:SetPoint("RIGHT", sessionContent, "RIGHT")
    b.mark = widgets.Dot(b, 5)
    b.mark:SetPoint("RIGHT", -10, 0)
    b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    b:SetScript("OnClick", function(self, mouse)
        if mouse == "RightButton" then
            openRowMenu(self)
        else
            ns.Chat.Select(self.chatId)
        end
    end)
    b:SetScript("OnEnter", function(self)
        setHover(self, true)
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText(self.fullTitle)
        GameTooltip:AddLine(L["sidebar.rightClickOptions"], 0.7, 0.7, 0.7)
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function(self)
        GameTooltip:Hide()
        -- Moving onto the delete button stays inside the row.
        if not (self.IsMouseOver and self:IsMouseOver()) then
            setHover(self, false)
        end
    end)
    b.delete = CreateFrame("Button", nil, b)
    b.delete:SetSize(18, 18)
    b.delete:SetPoint("RIGHT", -4, 0)
    b.delete.icon = b.delete:CreateTexture(nil, "ARTWORK")
    b.delete.icon:SetTexture(widgets.TEXTURES .. "Close.tga")
    b.delete.icon:SetSize(10, 10)
    b.delete.icon:SetPoint("CENTER")
    b.delete.icon:SetVertexColor(unpack(COLORS.secondary))
    widgets.Hover(b.delete, 0.08)
    b.delete:SetScript("OnClick", function()
        ns.UI.RequestDeleteChat(b.chatId)
    end)
    b.delete:Hide()
    b.delete:SetScript("OnEnter", function(self)
        self.icon:SetVertexColor(unpack(TEXT))
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText(L["sidebar.deleteConversation"])
        GameTooltip:Show()
    end)
    b.delete:SetScript("OnLeave", function(self)
        self.icon:SetVertexColor(unpack(COLORS.secondary))
        GameTooltip:Hide()
        if not (b.IsMouseOver and b:IsMouseOver()) then
            setHover(b, false)
        end
    end)
    return b
end

-- Conversations started by the player; routine runs live on the Routines page.
local function chatEntries()
    local ordered, positions = {}, {}
    for index, session in ipairs(ns.chats) do
        if not session.inline and not session.proactive and not session.routineId then
            ordered[#ordered + 1] = session
            positions[session.id] = index
        end
    end
    table.sort(ordered, function(a, b)
        local aTime, bTime = a.lastActivityAt or 0, b.lastActivityAt or 0
        if aTime == bTime then
            return positions[a.id] < positions[b.id]
        end
        return aTime > bTime
    end)
    return ordered
end

-- Shows the `index`th pooled day heading at offset `y` of the list.
local function placeHeader(index, text, y)
    local header = dayHeaders[index]
    if not header then
        header = widgets.Caption(sessionContent, "")
        header:SetWordWrap(false)
        dayHeaders[index] = header
    end
    if header.y ~= y then
        header.y = y
        header:ClearAllPoints()
        header:SetPoint("TOPLEFT", 10, -y)
        header:SetPoint("RIGHT", sessionContent, "RIGHT", -10, 0)
    end
    setText(header, text)
    if not header:IsShown() then
        header:Show()
    end
end

local function refreshFooter()
    local name, classLevel, state = characterLine()
    widgets.SetContentText(footer.name, name, FONTS.strong)
    -- First UTF-8 character, so accented names keep a whole glyph.
    widgets.SetContentText(
        footer.initial,
        string.upper(name:match("^[%z\1-\127\194-\244][\128-\191]*") or ""),
        FONTS.strong
    )
    -- Name and class/level are written out; the connection is the avatar's dot,
    -- with its state spelled out only in the avatar's tooltip.
    widgets.SetContentText(footer.detail, classLevel, FONTS.small)
    footer.tooltip = classLevel ~= "" and (classLevel .. " · " .. state) or state
    local tint = ns.Transport.needsDesktopSetup and COLORS.warning
        or (ns.connected and COLORS.success or COLORS.muted)
    footer.status:SetColorTexture(unpack(tint))
end

function ns.UI.Sidebar.Refresh()
    -- While Settings covers the panel, neither section is the current view.
    local inSettings = ns.UI.SettingsShown and ns.UI.SettingsShown()
    local routines = ns.sidebarTab == "routines"
    widgets.SetSelected(routinesTab, routines and not inSettings)
    widgets.SetSelected(
        newChatTab,
        ns.composingNew == true and not ns.routinesPage and not inSettings
    )
    refreshFooter()
    local used, y, headerCount, lastDay = {}, 0, 0, nil
    for _, session in ipairs(chatEntries()) do
        local day = widgets.DayBucket(session.lastActivityAt)
        if day ~= lastDay then
            lastDay = day
            headerCount = headerCount + 1
            y = y + (headerCount > 1 and HEADER_GAP or HEADER_TOP)
            placeHeader(headerCount, day, y)
            y = y + HEADER_HEIGHT
        end
        local b = sessionButtons[session.id]
        if not b then
            b = makeRow()
            sessionButtons[session.id] = b
        end
        used[session.id] = true
        b.chatId, b.fullTitle = session.id, session.title
        local selected = session.id == ns.active and not ns.routinesPage
        widgets.SetSelected(b, selected)
        local busy = session.status == "working"
        b.selected = selected
        b.marked = not selected and (busy or session.unread == true)
        b.mark:SetColorTexture(unpack(busy and ACCENT or TEXT))
        paintRowEnd(b)
        widgets.SetContentText(b.label, session.title, selected and FONTS.strong or FONTS.body)
        if b.y ~= y then
            b.y = y
            b:ClearAllPoints()
            b:SetPoint("TOPLEFT", 0, -y)
            b:SetPoint("RIGHT", sessionContent, "RIGHT")
        end
        if not b:IsShown() then
            b:Show()
        end
        y = y + CHAT_ROW + ROW_GAP
    end
    sessionContent:SetHeight(math.max(1, y))
    for id, b in pairs(sessionButtons) do
        if not used[id] and b:IsShown() then
            b:Hide()
        end
    end
    for index = headerCount + 1, #dayHeaders do
        if dayHeaders[index]:IsShown() then
            dayHeaders[index]:Hide()
        end
    end
end

local function buildFooter()
    footer = CreateFrame("Frame", nil, sidebar)
    footer:SetPoint("BOTTOMLEFT", 0, 0)
    footer:SetPoint("BOTTOMRIGHT", 0, 0)
    footer:SetHeight(FOOTER_HEIGHT)
    local rule = footer:CreateTexture(nil, "ARTWORK")
    rule:SetPoint("TOPLEFT", 8, 0)
    rule:SetPoint("TOPRIGHT", -8, 0)
    rule:SetHeight(widgets.OnePixel(rule))
    ns.UI.Widgets.Tint(rule, COLORS.line)
    footer.avatar = CreateFrame("Frame", nil, footer, "BackdropTemplate")
    footer.avatar:SetSize(26, 26)
    footer.avatar:SetPoint("LEFT", 10, -1)
    widgets.Box(footer.avatar, COLORS.selected, COLORS.lineStrong)
    footer.status = widgets.Dot(footer.avatar, 6, COLORS.muted)
    footer.status:SetPoint("BOTTOMRIGHT", footer.avatar, "BOTTOMRIGHT", 2, -2)
    footer.avatar:EnableMouse(true)
    footer.avatar:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(footer.name:GetText() or "")
        if footer.tooltip and footer.tooltip ~= "" then
            GameTooltip:AddLine(footer.tooltip, 1, 1, 1)
        end
        GameTooltip:Show()
    end)
    footer.avatar:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    footer.name = label(footer, "", TEXT, FONTS.strong)
    footer.name:SetPoint("TOPLEFT", footer.avatar, "TOPRIGHT", 8, 1)
    footer.name:SetPoint("RIGHT", -32, 0)
    footer.name:SetWordWrap(false)
    footer.detail = label(footer, "", COLORS.secondary, FONTS.small)
    footer.detail:SetPoint("TOPLEFT", footer.name, "BOTTOMLEFT", 0, -2)
    footer.detail:SetPoint("RIGHT", -32, 0)
    footer.detail:SetWordWrap(false)
    footer.initial = label(footer.avatar, "", TEXT, FONTS.strong)
    footer.initial:SetPoint("CENTER", 0, 0)
    footer.initial:SetJustifyH("CENTER")
    footer.profile = { rule, footer.avatar, footer.name, footer.detail }
end

-- The footer hosts the window's settings button next to the character.
function ns.UI.Sidebar.Footer()
    return footer
end

local function navItem(text, click, icon)
    local item = widgets.NavItem(sidebar, text, NAV_ROW - 2, click, widgets.TEXTURES .. icon)
    item.accentBar = true
    item:SetFontString(item.label)
    item:SetText(text)
    return item
end

function ns.UI.Sidebar.Build(body)
    StaticPopupDialogs.WISPAI_DELETE_CHAT = {
        text = L["sidebar.deleteConfirm"],
        button1 = L["common.delete"],
        button2 = L["common.cancel"],
        OnAccept = function(_, id)
            ns.Chat.DeleteChat(id)
        end,
        timeout = 0,
        whileDead = true,
        hideOnEscape = true,
    }
    sidebar = CreateFrame("Frame", "WispAISidebar", body, "BackdropTemplate")
    sidebar:SetPoint("TOPLEFT")
    sidebar:SetPoint("BOTTOMLEFT")
    sidebar:SetWidth(DEFAULT_WIDTH)
    widgets.Box(sidebar, COLORS.sidebar, COLORS.line)
    -- A grip on the right edge resizes the sidebar; its edge lights while hovered
    -- or dragged, and the width is kept in the saved variables.
    local grip = CreateFrame("Button", "WispAISidebarResize", sidebar)
    grip:SetPoint("TOPRIGHT", 3, 0)
    grip:SetPoint("BOTTOMRIGHT", 3, 0)
    grip:SetWidth(6)
    grip:SetFrameLevel(sidebar:GetFrameLevel() + 20)
    grip.edge = grip:CreateTexture(nil, "OVERLAY")
    grip.edge:SetPoint("TOP")
    grip.edge:SetPoint("BOTTOM")
    grip.edge:SetWidth(2)
    widgets.Tint(grip.edge, COLORS.accentLine)
    grip.edge:Hide()
    local function cursorX()
        local x = GetCursorPosition()
        return x / (sidebar:GetEffectiveScale() or 1)
    end
    grip:SetScript("OnEnter", function(self)
        self.edge:Show()
    end)
    grip:SetScript("OnLeave", function(self)
        if not self.dragging then
            self.edge:Hide()
        end
    end)
    grip:SetScript("OnMouseDown", function(self)
        self.dragging, self.startX, self.startWidth = true, cursorX(), expandedWidth()
    end)
    grip:SetScript("OnMouseUp", function(self)
        self.dragging = false
        if not self:IsMouseOver() then
            self.edge:Hide()
        end
    end)
    grip:SetScript("OnUpdate", function(self)
        if not self.dragging then
            return
        end
        local width = math.floor(self.startWidth + cursorX() - self.startX + 0.5)
        width = math.max(MIN_WIDTH, math.min(MAX_WIDTH, width))
        if width ~= ns.db.sidebarWidth then
            ns.db.sidebarWidth = width
            ns.UI.Refresh()
        end
    end)
    -- New chat opens a blank conversation; it is created when the first message is sent.
    newChatTab = navItem(L["sidebar.newChat"], function()
        ns.Chat.StartNew()
    end, "Plus.tga")
    routinesTab = navItem(L["routines.title"], function()
        ns.UI.Routines.Show()
    end, "Clock.tga")
    -- Memory, integrations and saved panels are settings; they live under Settings > Data.
    -- Recents is the way back to a conversation, as in Claude: no separate Chats entry.
    nav = { newChatTab, routinesTab }
    for index, item in ipairs(nav) do
        local top = -6 - (index - 1) * NAV_ROW
        item:SetPoint("TOPLEFT", 6, top)
        item:SetPoint("RIGHT", -6, 0)
    end
    local listTop = -6 - #nav * NAV_ROW
    buildFooter()
    -- Recents are headed by their day headings, the first sitting where a
    -- "Recents" caption would.
    sessionScroll = CreateFrame("ScrollFrame", nil, sidebar)
    sessionScroll:SetPoint("TOPLEFT", 6, listTop - 6)
    sessionScroll:SetPoint("BOTTOMRIGHT", -6, FOOTER_HEIGHT + 4)
    sessionScroll:SetClipsChildren(true)
    sessionContent = CreateFrame("Frame", nil, sessionScroll)
    sessionContent:SetSize(DEFAULT_WIDTH - 12, 1)
    sessionScroll:SetScrollChild(sessionContent)
    sessionScroll:EnableMouseWheel(true)
    sessionScroll:SetScript("OnMouseWheel", function(self, delta)
        widgets.SetScroll(
            self,
            math.max(
                0,
                math.min(self:GetVerticalScrollRange(), self:GetVerticalScroll() - delta * 35)
            )
        )
    end)
end
