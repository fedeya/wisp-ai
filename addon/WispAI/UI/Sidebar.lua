local _, ns = ...
local widgets = ns.UI.Widgets
local COLORS, FONTS = widgets.COLORS, widgets.FONTS
local label, setText, button = widgets.Label, widgets.SetText, widgets.Button
local TEXT, MUTED, ACCENT = widgets.TEXT, widgets.MUTED, widgets.ACCENT
local EXPANDED_WIDTH = 190
local CHAT_ROW, ROW_GAP = 26, 2
local NAV_ROW, FOOTER_HEIGHT = 30, 46
local sidebar, nav, listCaption, footer
local sessionContent, sessionScroll
local sessionButtons = {}
local newChatTab, routinesTab

function ns.UI.RequestDeleteChat(id)
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            StaticPopup_Show("WISPAI_DELETE_CHAT", chat.title, nil, id)
            return
        end
    end
end

local function characterLine()
    local name = UnitName and UnitName("player") or nil
    local className = UnitClass and UnitClass("player") or nil
    local level = UnitLevel and UnitLevel("player") or nil
    local connection = ns.Transport.needsDesktopSetup and "setup required"
        or (ns.connected and "connected" or "offline")
    if className and level then
        connection = className .. " " .. level .. " · " .. connection
    end
    return name or "Wisp", connection
end

-- Returns the sidebar width so the window can anchor the conversation panel.
-- Collapsed, the sidebar is hidden entirely; its toggle lives in the title bar.
function ns.UI.Sidebar.Layout()
    local expanded = ns.db.sidebar == true
    sidebar:SetShown(expanded)
    local width = expanded and EXPANDED_WIDTH or 0
    sidebar:SetWidth(math.max(1, width))
    return width
end

--- Shows or hides the sidebar; the title bar's sidebar button calls it.
function ns.UI.Sidebar.Toggle()
    ns.db.sidebar = not ns.db.sidebar
    ns.UI.Refresh()
end

local function makeRow()
    local b = widgets.NavItem(sessionContent, "", CHAT_ROW)
    b:SetWidth(EXPANDED_WIDTH - 12)
    -- Conversation rows mark selection with the fill only; the accent bar is for navigation.
    b.bar:SetColorTexture(0, 0, 0, 0)
    b.label:SetPoint("RIGHT", -28, 0)
    b.mark = widgets.Dot(b, 5)
    b.mark:SetPoint("RIGHT", -10, 0)
    b:SetScript("OnClick", function(self)
        ns.Chat.Select(self.chatId)
    end)
    b:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText(self.fullTitle)
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    b.delete = button(b, "x", 18, function()
        ns.UI.RequestDeleteChat(b.chatId)
    end, "ghost")
    b.delete:SetSize(18, 18)
    b.delete:SetPoint("RIGHT", -4, 0)
    b.delete:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText("Delete conversation")
        GameTooltip:Show()
    end)
    b.delete:SetScript("OnLeave", function()
        GameTooltip:Hide()
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

local function refreshFooter()
    local name, detail = characterLine()
    setText(footer.name, name)
    -- First UTF-8 character, so accented names keep a whole glyph.
    setText(footer.initial, string.upper(name:match("^[%z\1-\127\194-\244][\128-\191]*") or ""))
    setText(footer.detail, detail)
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
    local used, y = {}, 0
    for _, session in ipairs(chatEntries()) do
        local b = sessionButtons[session.id]
        if not b then
            b = makeRow()
            sessionButtons[session.id] = b
        end
        used[session.id] = true
        b.chatId, b.fullTitle = session.id, session.title
        local selected = session.id == ns.active and not ns.routinesPage
        widgets.SetSelected(b, selected)
        if FONTS.strong then
            b.label:SetFontObject(selected and FONTS.strong or FONTS.body)
        end
        b.delete:SetShown(selected)
        local busy = session.status == "working"
        b.mark:SetShown(not selected and (busy or session.unread == true))
        b.mark:SetColorTexture(unpack(busy and ACCENT or TEXT))
        setText(b.label, session.title)
        if b.y ~= y then
            b.y = y
            b:ClearAllPoints()
            b:SetPoint("TOPLEFT", 0, -y)
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
    rule:SetColorTexture(unpack(COLORS.line))
    footer.avatar = CreateFrame("Frame", nil, footer, "BackdropTemplate")
    footer.avatar:SetSize(26, 26)
    footer.avatar:SetPoint("LEFT", 10, -1)
    widgets.Box(footer.avatar, COLORS.selected, COLORS.lineStrong)
    footer.status = widgets.Dot(footer.avatar, 6, COLORS.muted)
    footer.status:SetPoint("BOTTOMRIGHT", footer.avatar, "BOTTOMRIGHT", 2, -2)
    footer.name = label(footer, "", TEXT, FONTS.strong)
    footer.name:SetPoint("TOPLEFT", footer.avatar, "TOPRIGHT", 8, 1)
    footer.name:SetPoint("RIGHT", -32, 0)
    footer.name:SetWordWrap(false)
    footer.detail = label(footer, "", MUTED, FONTS.small)
    footer.detail:SetPoint("TOPLEFT", footer.name, "BOTTOMLEFT", 0, -3)
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
    item:SetFontString(item.label)
    item:SetText(text)
    return item
end

function ns.UI.Sidebar.Build(body)
    StaticPopupDialogs.WISPAI_DELETE_CHAT = {
        text = 'Delete "%s"? This conversation will be removed.',
        button1 = "Delete",
        button2 = "Cancel",
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
    sidebar:SetWidth(EXPANDED_WIDTH)
    widgets.Box(sidebar, COLORS.sidebar, COLORS.line)
    -- New chat opens a blank conversation; it is created when the first message is sent.
    newChatTab = navItem("New chat", function()
        ns.Chat.StartNew()
    end, "Plus.tga")
    routinesTab = navItem("Routines", function()
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
    listCaption = widgets.Caption(sidebar, "Recents")
    listCaption:SetPoint("TOPLEFT", 16, listTop - 12)
    buildFooter()
    sessionScroll = CreateFrame("ScrollFrame", nil, sidebar)
    sessionScroll:SetPoint("TOPLEFT", 6, listTop - 30)
    sessionScroll:SetPoint("BOTTOMRIGHT", -6, FOOTER_HEIGHT + 4)
    sessionScroll:SetClipsChildren(true)
    sessionContent = CreateFrame("Frame", nil, sessionScroll)
    sessionContent:SetSize(EXPANDED_WIDTH - 12, 1)
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
