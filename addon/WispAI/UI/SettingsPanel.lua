local _, ns = ...
local label, box, button = ns.UI.Widgets.Label, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.MUTED
local settings

-- The window supplies the overlay parent and the body it should cover.
function ns.UI.SettingsPanel.Build(frame, body)
    settings = CreateFrame("Frame", nil, frame, "BackdropTemplate")
    settings:SetAllPoints(body)
    settings:SetFrameLevel(frame:GetFrameLevel() + 15)
    box(settings, { 0.10, 0.085, 0.065, 1 }, 12)
    settings:Hide()
    local title = label(settings, "Settings", GOLD)
    title:SetPoint("TOPLEFT", 20, -20)
    local sound = CreateFrame("CheckButton", nil, settings, "UICheckButtonTemplate")
    sound:SetPoint("TOPLEFT", 17, -50)
    sound:SetChecked(ns.db.sound)
    sound:SetScript("OnClick", function(self)
        ns.db.sound = self:GetChecked()
        if ns.UI.PlayCompletionSound then
            ns.UI.PlayCompletionSound()
        end
    end)
    local st = label(settings, "Completion sound")
    st:SetPoint("LEFT", sound, "RIGHT", 4, 0)
    local tools = CreateFrame("CheckButton", nil, settings, "UICheckButtonTemplate")
    tools:SetPoint("TOPLEFT", 17, -85)
    tools:SetChecked(ns.db.showTools)
    tools:SetScript("OnClick", function(self)
        ns.db.showTools = self:GetChecked()
        ns.UI.Refresh()
    end)
    local tt = label(settings, "Show tool activity in conversations")
    tt:SetPoint("LEFT", tools, "RIGHT", 4, 0)
    local capabilitiesButton = button(settings, "Integrations", 125, function()
        ns.UI.Capabilities.Show()
    end)
    capabilitiesButton:SetPoint("TOPLEFT", 20, -120)
    local memoryButton = button(settings, "Memory", 90, function()
        ns.UI.Memory.Show()
    end)
    memoryButton:SetPoint("LEFT", capabilitiesButton, "RIGHT", 10, 0)
    local bind = button(settings, "Bind inline chat", 140, function()
        if ns.Inline.BindInline then
            ns.Inline.BindInline()
        end
    end)
    bind:SetPoint("TOPLEFT", 20, -155)
    local panelButton = button(settings, "Show saved panels", 155, function()
        if ns.Panels.ShowPanels then
            ns.Panels.ShowPanels()
        end
    end)
    panelButton:SetPoint("LEFT", bind, "RIGHT", 10, 0)
    local bindHint =
        label(settings, "Hover a reference and use your inline key. /wisp ask also works.", MUTED)
    bindHint:SetPoint("TOPLEFT", 20, -190)
    bindHint:SetPoint("RIGHT", -20, 0)
    bindHint:SetWordWrap(true)
    local chatSettings =
        CreateFrame("Frame", "WispAIChatHistorySettings", settings, "BackdropTemplate")
    chatSettings:SetAllPoints(settings)
    chatSettings:SetFrameLevel(settings:GetFrameLevel() + 5)
    box(chatSettings, { 0.10, 0.085, 0.065, 1 }, 12)
    chatSettings:Hide()
    local chatTitle = label(chatSettings, "WoW chat history", GOLD)
    chatTitle:SetPoint("TOPLEFT", 20, -20)
    local chatHint = label(
        chatSettings,
        "Up to 200 messages / 30 minutes, until logout or reload.\nEnabled channels are shared with your AI provider when consulted.",
        MUTED
    )
    chatHint:SetPoint("TOPLEFT", 20, -50)
    chatHint:SetPoint("RIGHT", -20, 0)
    chatHint:SetWordWrap(true)
    local chatScroll = CreateFrame("ScrollFrame", nil, chatSettings, "UIPanelScrollFrameTemplate")
    chatScroll:SetPoint("TOPLEFT", 17, -100)
    chatScroll:SetPoint("BOTTOMRIGHT", -35, 60)
    local chatContent = CreateFrame("Frame", nil, chatScroll)
    chatContent:SetSize(340, 325)
    chatScroll:SetScrollChild(chatContent)
    for index, channel in ipairs(ns.ChatHistory.ChatChannels or {}) do
        local id = channel.id
        local check = CreateFrame(
            "CheckButton",
            "WispAIChatChannel_" .. id,
            chatContent,
            "UICheckButtonTemplate"
        )
        check:SetPoint("TOPLEFT", 0, -(index - 1) * 35)
        check:SetChecked(ns.ChatHistory.ChatChannelEnabled(id))
        check:SetScript("OnClick", function(self)
            ns.ChatHistory.SetChatChannel(id, self:GetChecked())
        end)
        local text = label(chatContent, channel.label)
        text:SetPoint("LEFT", check, "RIGHT", 4, 0)
    end
    local publicTitle = label(chatContent, "Public / custom channels", GOLD)
    local publicTop = #(ns.ChatHistory.ChatChannels or {}) * 35 + 10
    publicTitle:SetPoint("TOPLEFT", 3, -publicTop)
    local publicHint =
        label(chatContent, "Choose individual channels. Selections follow the channel name.", MUTED)
    publicHint:SetPoint("TOPLEFT", 3, -publicTop - 25)
    publicHint:SetWidth(310)
    publicHint:SetWordWrap(true)
    local publicRows = {}
    local publicEmpty = label(chatContent, "No public channels joined.", MUTED)
    publicEmpty:SetPoint("TOPLEFT", 3, -publicTop - 70)
    function ns.UI.RefreshChatChannelSettings()
        local channels = ns.ChatHistory.PublicChatChannels and ns.ChatHistory.PublicChatChannels()
            or {}
        for _, row in ipairs(publicRows) do
            row.check:Hide()
            row.text:Hide()
        end
        for index, channel in ipairs(channels) do
            local row = publicRows[index]
            if not row then
                local check = CreateFrame(
                    "CheckButton",
                    "WispAIPublicChatChannel_" .. index,
                    chatContent,
                    "UICheckButtonTemplate"
                )
                local text = label(chatContent, "")
                text:SetPoint("LEFT", check, "RIGHT", 4, 0)
                text:SetWidth(285)
                row = { check = check, text = text }
                publicRows[index] = row
                check:SetScript("OnClick", function(self)
                    ns.ChatHistory.SetPublicChatChannel(self.channelName, self:GetChecked())
                end)
            end
            row.check.channelName = channel.name
            row.check:SetPoint("TOPLEFT", 0, -publicTop - 65 - (index - 1) * 35)
            row.check:SetChecked(ns.ChatHistory.PublicChatChannelEnabled(channel.name))
            row.text:SetText(
                "/"
                    .. channel.id
                    .. " "
                    .. channel.name
                    .. (channel.disabled and " (unavailable here)" or "")
            )
            row.check:Show()
            row.text:Show()
        end
        publicEmpty:SetShown(#channels == 0)
        chatContent:SetHeight(publicTop + 75 + math.max(1, #channels) * 35)
    end
    chatSettings:SetScript("OnShow", ns.UI.RefreshChatChannelSettings)
    ns.UI.RefreshChatChannelSettings()
    local clearChat = button(chatSettings, "Clear history", 125, function()
        ns.ChatHistory.ClearChatHistory()
    end)
    clearChat:SetPoint("BOTTOMLEFT", 20, 20)
    local chatBack = button(chatSettings, "Back", 90, function()
        chatSettings:Hide()
    end)
    chatBack:SetPoint("LEFT", clearChat, "RIGHT", 10, 0)
    local chatButton = button(settings, "WoW chat history", 155, function()
        chatSettings:Show()
    end)
    chatButton:SetPoint("TOPLEFT", 20, -230)
    local back = button(settings, "Back", 90, function()
        settings:Hide()
    end)
    back:SetPoint("LEFT", chatButton, "RIGHT", 10, 0)
    ns.UI.Capabilities.Build(settings)
    ns.UI.Memory.Build(settings)
    return settings
end
