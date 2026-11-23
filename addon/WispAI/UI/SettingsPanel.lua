local _, ns = ...
local L = ns.L
local widgets = ns.UI.Widgets
local COLORS, FONTS = widgets.COLORS, widgets.FONTS
local label, box, button = widgets.Label, widgets.Box, widgets.Button
local TEXT, MUTED = widgets.TEXT, widgets.MUTED
local PAGE_INSET, ROW_HEIGHT = 24, 32
local settings, chatHistoryPage

-- A settings line with its label on the left and a switch on the right.
local function switchRow(parent, top, text, checked, onChange)
    local row = CreateFrame("Frame", nil, parent)
    row:SetPoint("TOPLEFT", PAGE_INSET, top)
    row:SetPoint("RIGHT", -PAGE_INSET, 0)
    row:SetHeight(ROW_HEIGHT)
    local caption = label(row, text)
    caption:SetPoint("LEFT", 0, 0)
    caption:SetPoint("RIGHT", -44, 0)
    caption:SetWordWrap(false)
    local switch = widgets.Toggle(row)
    switch:SetPoint("RIGHT", 0, 0)
    switch:SetChecked(checked)
    switch:SetScript("OnClick", function(self)
        onChange(self:GetChecked())
    end)
    local rule = row:CreateTexture(nil, "ARTWORK")
    rule:SetPoint("BOTTOMLEFT")
    rule:SetPoint("BOTTOMRIGHT")
    rule:SetHeight(widgets.OnePixel(rule))
    ns.UI.Widgets.Tint(rule, COLORS.line)
    return row, switch
end

-- Each language is named in its own language (enUS holds the names), so a
-- name in another script needs that script's game font on this client.
local function languageName(choice)
    if choice == "auto" then
        return L["settings.languageAuto"]
    elseif choice == "interface" then
        return L["settings.chatLanguageInterface"]
    end
    return L["language." .. choice]
end

local function showLanguage(selector, choice)
    selector:SetText(languageName(choice))
    local text = selector.GetFontString and selector:GetFontString()
    if text and FONTS.button then
        text:SetFontObject(FONTS.button)
    end
    widgets.UseLanguageFace(text, choice)
end

-- The two language lines: the UI's, and the chat's for what Wisp writes for the
-- player to send. Each is a menu of `choices` saved in `ns.db[field]`.
local LANGUAGE_SETTINGS = {
    {
        field = "language",
        caption = "settings.language",
        choices = ns.LOCALE_CHOICES,
        default = "auto",
    },
    {
        field = "chatLanguage",
        caption = "settings.chatLanguage",
        choices = ns.CHAT_LOCALE_CHOICES,
        default = "interface",
    },
}

-- Saves a language. Text and fonts are set when the window is built, so a
-- change asks to reload the interface instead of half-translating the window.
local function chooseLanguage(setting, choice, selector)
    if (ns.db[setting.field] or setting.default) == choice then
        return
    end
    ns.db[setting.field] = choice
    showLanguage(selector, choice)
    StaticPopup_Show("WISPAI_RELOAD_LANGUAGE")
end

local function languageRow(parent, top, setting)
    StaticPopupDialogs.WISPAI_RELOAD_LANGUAGE = {
        text = L["settings.reloadForLanguage"],
        button1 = L["settings.reload"],
        button2 = L["settings.later"],
        OnAccept = function()
            ReloadUI()
        end,
        timeout = 0,
        whileDead = true,
        hideOnEscape = true,
    }
    local row = CreateFrame("Frame", nil, parent)
    row:SetPoint("TOPLEFT", PAGE_INSET, top)
    row:SetPoint("RIGHT", -PAGE_INSET, 0)
    row:SetHeight(ROW_HEIGHT)
    local caption = label(row, L[setting.caption])
    caption:SetPoint("LEFT", 0, 0)
    caption:SetPoint("RIGHT", -190, 0)
    caption:SetWordWrap(false)
    local selector
    selector = button(row, "", 180, function(self)
        if not (MenuUtil and MenuUtil.CreateContextMenu) then
            return
        end
        MenuUtil.CreateContextMenu(self, function(_, root)
            for _, choice in ipairs(setting.choices) do
                local option = choice
                local radio = root:CreateRadio(languageName(option), function()
                    return (ns.db[setting.field] or setting.default) == option
                end, function()
                    chooseLanguage(setting, option, selector)
                end)
                if radio and radio.AddInitializer then
                    radio:AddInitializer(function(item)
                        widgets.UseLanguageFace(item.fontString, option)
                    end)
                end
            end
        end)
    end)
    selector:SetPoint("RIGHT", 0, 0)
    showLanguage(selector, ns.db[setting.field] or setting.default)
    local rule = row:CreateTexture(nil, "ARTWORK")
    rule:SetPoint("BOTTOMLEFT")
    rule:SetPoint("BOTTOMRIGHT")
    rule:SetHeight(widgets.OnePixel(rule))
    ns.UI.Widgets.Tint(rule, COLORS.line)
    settings[setting.field] = selector
    return row
end

-- A full-width row that opens another page.
local function linkRow(parent, top, text, detail, onClick)
    local row = widgets.NavItem(parent, text, ROW_HEIGHT, onClick)
    row:SetPoint("TOPLEFT", PAGE_INSET - 10, top)
    row:SetPoint("RIGHT", -PAGE_INSET + 10, 0)
    row.label:SetTextColor(unpack(TEXT))
    row.label:SetPoint("RIGHT", -150, 0)
    local hint = label(row, detail, MUTED, FONTS.small)
    hint:SetPoint("RIGHT", -24, 0)
    local chevron = label(row, ">", MUTED)
    chevron:SetPoint("RIGHT", -10, 0)
    return row
end

--- Header shared by Settings subpages: a band with the "Settings" back link,
--- closed by a hairline, then the page title. Content starts at SUBPAGE_TOP.
local BACK_BAND = 40
ns.UI.SettingsPanel.SUBPAGE_TOP = -98
function ns.UI.SettingsPanel.SubpageHeader(page, title)
    local back = widgets.BackLink(page, L["settings.title"], function()
        page:Hide()
    end)
    back:SetPoint("TOPLEFT", PAGE_INSET, -10)
    local rule = page:CreateTexture(nil, "ARTWORK")
    rule:SetPoint("TOPLEFT", 0, -BACK_BAND)
    rule:SetPoint("TOPRIGHT", 0, -BACK_BAND)
    rule:SetHeight(widgets.OnePixel(rule))
    ns.UI.Widgets.Tint(rule, COLORS.line)
    local heading = label(page, title, TEXT, FONTS.heading)
    heading:SetPoint("TOPLEFT", PAGE_INSET, -BACK_BAND - 22)
    return heading, back
end
local subpageHeader = ns.UI.SettingsPanel.SubpageHeader

local function buildChatHistory()
    local chatSettings =
        CreateFrame("Frame", "WispAIChatHistorySettings", settings, "BackdropTemplate")
    chatSettings:SetAllPoints(settings)
    chatSettings:SetFrameLevel(settings:GetFrameLevel() + 5)
    box(chatSettings, COLORS.window, COLORS.window)
    chatSettings:Hide()
    subpageHeader(chatSettings, L["chatHistory.title"])
    local chatHint = label(chatSettings, L["chatHistory.hint"], MUTED)
    chatHint:SetPoint("TOPLEFT", PAGE_INSET, ns.UI.SettingsPanel.SUBPAGE_TOP)
    chatHint:SetPoint("RIGHT", -PAGE_INSET, 0)
    chatHint:SetWordWrap(true)
    local chatScroll, chatContent = widgets.ScrollArea(chatSettings)
    chatScroll:SetPoint("TOPLEFT", PAGE_INSET, ns.UI.SettingsPanel.SUBPAGE_TOP - 44)
    chatScroll:SetPoint("BOTTOMRIGHT", -PAGE_INSET, 56)
    chatContent:SetSize(340, 325)
    chatScroll:SetScript("OnSizeChanged", function(_, width)
        chatContent:SetWidth(width)
    end)
    local function channelRow(top, name)
        local row = CreateFrame("Frame", nil, chatContent)
        row:SetPoint("TOPLEFT", 0, top)
        row:SetPoint("RIGHT", 0, 0)
        row:SetHeight(ROW_HEIGHT)
        row.text = label(row, "")
        row.text:SetPoint("LEFT", 0, 0)
        row.text:SetPoint("RIGHT", -44, 0)
        row.text:SetWordWrap(false)
        row.check = widgets.Toggle(row, name)
        row.check:SetPoint("RIGHT", -2, 0)
        return row
    end
    for index, channel in ipairs(ns.ChatHistory.ChatChannels or {}) do
        local id = channel.id
        local row = channelRow(-(index - 1) * ROW_HEIGHT, "WispAIChatChannel_" .. id)
        row.text:SetText(channel.label)
        row.check:SetChecked(ns.ChatHistory.ChatChannelEnabled(id))
        row.check:SetScript("OnClick", function(self)
            ns.ChatHistory.SetChatChannel(id, self:GetChecked())
        end)
    end
    local publicTop = #(ns.ChatHistory.ChatChannels or {}) * ROW_HEIGHT + 16
    local publicTitle = widgets.Caption(chatContent, L["chatHistory.publicChannels"])
    publicTitle:SetPoint("TOPLEFT", 0, -publicTop)
    local publicHint = label(chatContent, L["chatHistory.publicHint"], MUTED)
    publicHint:SetPoint("TOPLEFT", 0, -publicTop - 18)
    publicHint:SetPoint("RIGHT", 0, 0)
    publicHint:SetWordWrap(true)
    local listTop = publicTop + 48
    local publicRows = {}
    local publicEmpty = label(chatContent, L["chatHistory.noPublic"], MUTED)
    publicEmpty:SetPoint("TOPLEFT", 0, -listTop - 6)
    function ns.UI.RefreshChatChannelSettings()
        local channels = ns.ChatHistory.PublicChatChannels and ns.ChatHistory.PublicChatChannels()
            or {}
        for _, row in ipairs(publicRows) do
            row:Hide()
            row.check:Hide()
        end
        for index, channel in ipairs(channels) do
            local row = publicRows[index]
            if not row then
                row = channelRow(0, "WispAIPublicChatChannel_" .. index)
                publicRows[index] = row
                row.check:SetScript("OnClick", function(self)
                    ns.ChatHistory.SetPublicChatChannel(self.channelName, self:GetChecked())
                end)
            end
            row:ClearAllPoints()
            row:SetPoint("TOPLEFT", 0, -listTop - (index - 1) * ROW_HEIGHT)
            row:SetPoint("RIGHT", 0, 0)
            row.check.channelName = channel.name
            row.check:SetChecked(ns.ChatHistory.PublicChatChannelEnabled(channel.name))
            row.text:SetText(
                "/"
                    .. channel.id
                    .. " "
                    .. channel.name
                    .. (channel.disabled and " (unavailable here)" or "")
            )
            row:Show()
            row.check:Show()
        end
        publicEmpty:SetShown(#channels == 0)
        chatContent:SetHeight(listTop + math.max(1, #channels) * ROW_HEIGHT + 8)
    end
    chatSettings:SetScript("OnShow", ns.UI.RefreshChatChannelSettings)
    ns.UI.RefreshChatChannelSettings()
    local clearChat = button(chatSettings, L["chatHistory.clear"], 120, function()
        ns.ChatHistory.ClearChatHistory()
    end)
    clearChat:SetPoint("BOTTOMLEFT", PAGE_INSET, 20)
    return chatSettings
end

--- Closes the open subpage, if any; returns whether one was open.
function ns.UI.SettingsPanel.CloseSubpage()
    local open = (chatHistoryPage and chatHistoryPage:IsShown())
        or ns.UI.Memory.IsShown()
        or ns.UI.Capabilities.IsShown()
    ns.UI.SettingsPanel.ResetPages()
    return open == true
end

-- Returns Settings to its main page by closing any open subpage.
function ns.UI.SettingsPanel.ResetPages()
    if chatHistoryPage then
        chatHistoryPage:Hide()
    end
    ns.UI.Memory.Hide()
    ns.UI.Capabilities.Hide()
end

-- The window supplies the overlay parent and the conversation panel it covers.
function ns.UI.SettingsPanel.Build(frame, panel)
    settings = CreateFrame("Frame", "WispAISettingsPage", frame, "BackdropTemplate")
    settings:SetAllPoints(panel)
    settings:SetFrameLevel(frame:GetFrameLevel() + 15)
    box(settings, COLORS.window, COLORS.window)
    settings:EnableMouse(true)
    settings:Hide()
    local title = label(settings, L["settings.title"], TEXT, FONTS.heading)
    title:SetPoint("TOPLEFT", PAGE_INSET, -20)
    local close = button(settings, "x", 24, function()
        ns.UI.ShowSettings(nil)
    end, "ghost")
    close:SetPoint("TOPRIGHT", -PAGE_INSET + 6, -16)

    local general = widgets.Caption(settings, L["settings.general"])
    general:SetPoint("TOPLEFT", PAGE_INSET, -62)
    switchRow(settings, -76, L["settings.completionSound"], ns.db.sound, function(value)
        ns.db.sound = value
        if ns.UI.PlayCompletionSound then
            ns.UI.PlayCompletionSound()
        end
    end)
    switchRow(settings, -76 - ROW_HEIGHT, L["settings.showTools"], ns.db.showTools, function(value)
        ns.db.showTools = value
        ns.UI.Refresh()
    end)

    for index, setting in ipairs(LANGUAGE_SETTINGS) do
        languageRow(settings, -76 - ROW_HEIGHT * (index + 1), setting)
    end
    local below = -ROW_HEIGHT * (#LANGUAGE_SETTINGS - 1) -- shift for the extra rows

    local inline = widgets.Caption(settings, L["settings.inlineChat"])
    inline:SetPoint("TOPLEFT", PAGE_INSET, -196 + below)
    local bindHint = label(settings, L["settings.inlineHint"], MUTED)
    bindHint:SetPoint("TOPLEFT", PAGE_INSET, -214 + below)
    bindHint:SetPoint("RIGHT", -150, 0)
    bindHint:SetWordWrap(true)
    local bind = button(settings, L["settings.bindInline"], 120, function()
        if ns.Inline.BindInline then
            ns.Inline.BindInline()
        end
    end)
    bind:SetPoint("TOPRIGHT", -PAGE_INSET, -210 + below)

    local data = widgets.Caption(settings, L["settings.data"])
    data:SetPoint("TOPLEFT", PAGE_INSET, -262 + below)
    local chatSettings = buildChatHistory()
    chatHistoryPage = chatSettings
    local links = {
        {
            L["integrations.title"],
            L["settings.integrationsHint"],
            function()
                ns.UI.Capabilities.Show()
            end,
        },
        {
            L["memory.title"],
            L["settings.memoryHint"],
            function()
                ns.UI.Memory.Show()
            end,
        },
        {
            L["chatHistory.title"],
            L["settings.chatHistoryHint"],
            function()
                chatSettings:Show()
            end,
        },
        {
            L["settings.savedPanels"],
            L["settings.savedPanelsHint"],
            function()
                if ns.Panels.ShowPanels then
                    ns.Panels.ShowPanels()
                end
            end,
        },
    }
    for index, link in ipairs(links) do
        linkRow(settings, -278 + below - (index - 1) * ROW_HEIGHT, link[1], link[2], link[3])
    end
    ns.UI.Capabilities.Build(settings)
    ns.UI.Memory.Build(settings)
    return settings
end
