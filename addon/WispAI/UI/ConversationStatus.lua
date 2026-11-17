local _, ns = ...
local L = ns.L
local label, setText, MUTED = ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.MUTED
local sessionTitle, separator, status, statusMark, contextMeter
local sectionLink, sectionSeparator

-- A routine's conversation is either tagged by the bridge or listed as a run.
-- Returns the routine id and, when listed, the run.
local function routineOf(chat)
    if not chat then
        return nil
    end
    local id, found = chat.routineId, nil
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.id == chat.id then
            id, found = id or run.routineId, run
        end
    end
    return id, found
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
    local problem = ns.Transport.needsDesktopSetup and L["status.setupRequired"]
        or ns.exhausted and L["status.channelsExhausted"]
        or (not ns.connected and L["status.openDesktop"])
    -- The sidebar footer shows a healthy connection; the header only reports problems.
    setText(status, problem or "")
    status:SetShown(problem ~= nil and not ns.db.minimized)
    statusMark:SetShown(status:IsShown())
    local usage = chat and chat.usage
    local window = ns.contextPolicy and ns.contextPolicy.windowTokens
    local measured = usage and usage.contextTokens
    local meterText = usage and usage.compacting and L["context.compacting"]
        or (measured and window and string.format(L["context.percent"], measured / window * 100))
        or L["context.unknown"]
    setText(contextMeter.text, meterText)
    -- The header reads as a breadcrumb: "Wisp AI / <where you are>". A routine's
    -- conversation adds a "Routines" step that leads back to the Routines page.
    local inSettings = ns.UI.SettingsShown and ns.UI.SettingsShown()
    local onRoutinesPage = ns.routinesPage and ns.sidebarTab == "routines"
    local routineId, run = routineOf(chat)
    local inRoutine = not inSettings and not onRoutinesPage and routineId ~= nil
    local place = inSettings and L["settings.title"]
        or (onRoutinesPage and L["routines.title"])
        or (chat and chat.title)
        or L["header.newConversation"]
    if inRoutine then
        -- "<routine> / <event>": the routine step opens that routine's page.
        local routineTitle = ns.UI.Routines.Title and ns.UI.Routines.Title(routineId)
        sectionLink.routineId = routineTitle and routineId or nil
        setText(sectionLink.label, routineTitle or L["routines.title"])
        sectionLink:SetWidth(math.max(40, (sectionLink.label:GetStringWidth() or 0) + 2))
        if run and run.event and ns.UI.Routines.EventLabel then
            place = ns.UI.Routines.EventLabel(run.event)
        end
    end
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
    -- Breadcrumb steps are divided by a small chevron: the back chevron, mirrored.
    local function chevron()
        local mark = header:CreateTexture(nil, "ARTWORK")
        mark:SetTexture(widgets.TEXTURES .. "Back.tga")
        mark:SetTexCoord(1, 0, 0, 1)
        mark:SetSize(9, 9)
        mark:SetVertexColor(unpack(widgets.COLORS.muted))
        return mark
    end
    separator = chevron()
    separator:SetPoint("LEFT", header.title, "RIGHT", 10, 0)
    sectionLink = CreateFrame("Button", "WispAIRoutinesCrumb", header)
    sectionLink:SetHeight(20)
    sectionLink:SetPoint("LEFT", separator, "RIGHT", 10, 0)
    sectionLink.label = label(sectionLink, L["routines.title"], MUTED, widgets.FONTS.body)
    sectionLink.label:SetPoint("LEFT")
    sectionLink:SetWidth(math.max(40, (sectionLink.label:GetStringWidth() or 0) + 2))
    sectionLink:SetScript("OnEnter", function(self)
        self.label:SetTextColor(unpack(widgets.TEXT))
    end)
    sectionLink:SetScript("OnLeave", function(self)
        self.label:SetTextColor(unpack(MUTED))
    end)
    sectionLink:SetScript("OnClick", function(self)
        if self.routineId then
            ns.UI.Routines.ShowRoutine(self.routineId)
        else
            ns.UI.Routines.Show()
        end
    end)
    sectionLink:Hide()
    sectionSeparator = chevron()
    sectionSeparator:SetPoint("LEFT", sectionLink, "RIGHT", 8, 0)
    sectionSeparator:Hide()
    sessionTitle = label(header, L["header.newConversation"], MUTED, widgets.FONTS.body)
    sessionTitle:SetWordWrap(false)
    sectionLink.inRoutine = true
    layoutCrumbs(false)
    contextMeter = CreateFrame("Button", "WispAIContextUsage", chatPanel)
    contextMeter:SetSize(96, 16)
    contextMeter:SetPoint("BOTTOMRIGHT", -22, 3)
    contextMeter.text = label(contextMeter, L["context.unknown"], MUTED, ns.UI.Widgets.FONTS.small)
    contextMeter.text:SetAllPoints(contextMeter)
    contextMeter.text:SetJustifyH("RIGHT")
    -- "24k", "1.2k" or "850".
    local function tokens(count)
        if count >= 10000 then
            return string.format("%dk", math.floor(count / 1000 + 0.5))
        elseif count >= 1000 then
            return string.format("%.1fk", count / 1000)
        end
        return tostring(count)
    end
    contextMeter:SetScript("OnEnter", function(self)
        local chat = ns.Chat.Current()
        local usage = chat and chat.usage
        local policy = ns.contextPolicy or {}
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:AddLine(L["context.title"])
        local used = usage and usage.contextTokens
        if used and policy.windowTokens then
            GameTooltip:AddLine(
                L["context.tokensOf"]:format(tokens(used), tokens(policy.windowTokens)),
                1,
                1,
                1
            )
        elseif used then
            GameTooltip:AddLine(L["context.tokens"]:format(tokens(used)), 1, 1, 1)
        else
            GameTooltip:AddLine(L["context.notMeasured"], 1, 1, 1)
        end
        if policy.compactAt then
            GameTooltip:AddLine(
                string.format(L["context.compactAt"], policy.compactAt * 100),
                0.7,
                0.7,
                0.7,
                true
            )
        end
        GameTooltip:Show()
    end)
    contextMeter:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
end
