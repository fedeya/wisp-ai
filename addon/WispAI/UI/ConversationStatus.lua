local _, ns = ...
local label, setText, MUTED = ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.MUTED
local sessionTitle, separator, status, statusMark, contextMeter
local sectionLink, sectionSeparator

-- A routine's conversation is either tagged by the bridge or listed as a run.
local function routineOf(chat)
    if not chat then
        return nil
    end
    local id = chat.routineId
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.id == chat.id then
            id = id or run.routineId
        end
    end
    return id
end

-- Re-anchors the breadcrumb so the chat title follows "Routines /" only when shown.
local function layoutCrumbs(inRoutine)
    if sectionLink.inRoutine == inRoutine then
        return
    end
    sectionLink.inRoutine = inRoutine
    sessionTitle:ClearAllPoints()
    sessionTitle:SetPoint("LEFT", inRoutine and sectionSeparator or separator, "RIGHT", 10, 0)
    sessionTitle:SetPoint("RIGHT", status, "LEFT", -16, 0)
end

function ns.UI.ConversationStatus.Refresh(chat)
    local problem = ns.Transport.needsDesktopSetup and "Setup required"
        or ns.exhausted and "Channels exhausted: /reload"
        or (not ns.connected and "Open Wisp Desktop")
    -- The sidebar footer shows a healthy connection; the header only reports problems.
    setText(status, problem or "")
    status:SetShown(problem ~= nil and not ns.db.minimized)
    statusMark:SetShown(status:IsShown())
    local usage = chat and chat.usage
    local window = ns.contextPolicy and ns.contextPolicy.windowTokens
    local measured = usage and usage.contextTokens
    local meterText = usage and usage.compacting and "Compacting..."
        or (measured and window and string.format("Context ~%.0f%%", measured / window * 100))
        or "Context --"
    setText(contextMeter.text, meterText)
    -- The header reads as a breadcrumb: "Wisp AI / <where you are>". A routine's
    -- conversation adds a "Routines" step that leads back to the Routines page.
    local inSettings = ns.UI.SettingsShown and ns.UI.SettingsShown()
    local onRoutinesPage = ns.routinesPage and ns.sidebarTab == "routines"
    local inRoutine = not inSettings and not onRoutinesPage and routineOf(chat) ~= nil
    local place = inSettings and "Settings"
        or (onRoutinesPage and "Routines")
        or (chat and chat.title)
        or "New conversation"
    local visible = not ns.db.minimized
    layoutCrumbs(inRoutine)
    setText(sessionTitle, place)
    sessionTitle:SetTextColor(unpack(inRoutine and ns.UI.Widgets.TEXT or MUTED))
    sessionTitle:SetShown(visible)
    separator:SetShown(visible)
    sectionLink:SetShown(visible and inRoutine)
    sectionSeparator:SetShown(visible and inRoutine)
end

-- The context meter starts in the conversation panel; the composer moves it beside Send.
function ns.UI.ConversationStatus.ContextMeter()
    return contextMeter
end

function ns.UI.ConversationStatus.Build(chatPanel, header)
    local widgets = ns.UI.Widgets
    -- Connection problems sit right beside the minimize button.
    status = label(header, "", widgets.COLORS.warning, widgets.FONTS.small)
    status:SetPoint("RIGHT", header.mini, "LEFT", -10, 0)
    status:SetJustifyH("RIGHT")
    statusMark = widgets.Dot(header, 6, widgets.COLORS.warning)
    statusMark:SetPoint("RIGHT", status, "LEFT", -6, 0)
    separator = label(header, "/", widgets.COLORS.muted, widgets.FONTS.title)
    separator:SetPoint("LEFT", header.title, "RIGHT", 10, 0)
    sectionLink = CreateFrame("Button", "WispAIRoutinesCrumb", header)
    sectionLink:SetHeight(20)
    sectionLink:SetPoint("LEFT", separator, "RIGHT", 10, 0)
    sectionLink.label = label(sectionLink, "Routines", MUTED, widgets.FONTS.body)
    sectionLink.label:SetPoint("LEFT")
    sectionLink:SetWidth(math.max(40, (sectionLink.label:GetStringWidth() or 0) + 2))
    sectionLink:SetScript("OnEnter", function(self)
        self.label:SetTextColor(unpack(widgets.TEXT))
    end)
    sectionLink:SetScript("OnLeave", function(self)
        self.label:SetTextColor(unpack(MUTED))
    end)
    sectionLink:SetScript("OnClick", function()
        ns.UI.Routines.Show()
    end)
    sectionLink:Hide()
    sectionSeparator = label(header, "/", widgets.COLORS.muted, widgets.FONTS.title)
    sectionSeparator:SetPoint("LEFT", sectionLink, "RIGHT", 8, 0)
    sectionSeparator:Hide()
    sessionTitle = label(header, "New conversation", MUTED, widgets.FONTS.body)
    sessionTitle:SetWordWrap(false)
    sectionLink.inRoutine = true
    layoutCrumbs(false)
    contextMeter = CreateFrame("Button", "WispAIContextUsage", chatPanel)
    contextMeter:SetSize(96, 16)
    contextMeter:SetPoint("BOTTOMRIGHT", -22, 3)
    contextMeter.text = label(contextMeter, "Context --", MUTED, ns.UI.Widgets.FONTS.small)
    contextMeter.text:SetAllPoints(contextMeter)
    contextMeter.text:SetJustifyH("RIGHT")
    contextMeter:SetScript("OnEnter", function(self)
        local chat = ns.Chat.Current()
        local usage = chat and chat.usage
        local policy = ns.contextPolicy or {}
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:AddLine("Conversation context")
        if usage and usage.contextTokens then
            GameTooltip:AddLine(
                string.format("Last measured context: %d tokens", usage.contextTokens),
                1,
                1,
                1
            )
        else
            GameTooltip:AddLine("Context size not measured yet", 1, 1, 1)
        end
        if policy.windowTokens then
            GameTooltip:AddLine(
                string.format("Model capacity: %d tokens", policy.windowTokens),
                1,
                1,
                1
            )
        end
        if policy.compactAt then
            GameTooltip:AddLine(
                string.format(
                    "Auto compact: %.0f%% (includes summary overhead)",
                    policy.compactAt * 100
                ),
                1,
                1,
                1
            )
        end
        if usage then
            GameTooltip:AddLine(
                string.format(
                    "Observed input / output: %d / %d",
                    usage.inputTokens or 0,
                    usage.outputTokens or 0
                ),
                1,
                1,
                1
            )
            GameTooltip:AddLine(
                string.format(
                    "Cached input: %d | Compactions: %d",
                    usage.cacheReadTokens or 0,
                    usage.compactions or 0
                ),
                1,
                1,
                1
            )
        end
        GameTooltip:AddLine(
            "Context is approximate between model calls. Totals count repeated input and exclude separate search requests.",
            0.7,
            0.7,
            0.7,
            true
        )
        GameTooltip:AddLine(
            "This is conversation space, not your subscription allowance. Older context is summarized; chat messages stay visible.",
            0.7,
            0.7,
            0.7,
            true
        )
        GameTooltip:Show()
    end)
    contextMeter:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
end
