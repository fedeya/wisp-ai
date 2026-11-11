local _, ns = ...
local label, setText = ns.UI.Widgets.Label, ns.UI.Widgets.SetText
local GOLD, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.MUTED
local header, replyGlow, emptyState, progress
local progressTick = 0

function ns.UI.Activity.IsSending(chat)
    if chat and chat.status == "working" then
        for _, pending in pairs(ns.pendingMessages or {}) do
            if pending.chat == chat.id and not pending.acknowledged then
                return true
            end
        end
    end
    return false
end

function ns.UI.Activity.Refresh(chat)
    local working = chat and chat.status == "working"
    local empty = not chat or not chat.messages or #chat.messages == 0
    local waiting = not ns.connected
    local loading = chat and chat.messages == nil
    emptyState:SetShown(empty and not working)
    emptyState.loading = waiting or loading
    if empty and not working then
        setText(
            emptyState.title,
            waiting and "Waiting for bridge" or (loading and "Loading conversation" or "Ask Wisp")
        )
        setText(
            emptyState.detail,
            waiting and "Keep the Wisp desktop app open. Your chat will appear when it connects."
                or (
                    loading and "Fetching your messages."
                    or "Ask about your character, quests, equipment or where to go next."
                )
        )
        for _, dot in ipairs(emptyState.dots) do
            dot:SetShown(emptyState.loading)
        end
    end
    local title = "Wisp AI"
    if working then
        local now = GetTime()
        ns.workStarted[chat.id] = ns.workStarted[chat.id] or now
        local seconds = math.max(0, math.floor(now - ns.workStarted[chat.id]))
        local elapsed = seconds < 60 and (seconds .. "s")
            or string.format("%dm %02ds", math.floor(seconds / 60), seconds % 60)
        local sending = ns.UI.Activity.IsSending(chat)
        local compacting = chat.usage and chat.usage.compacting
        local phase = compacting and "Compacting" or "Thinking"
        local dots = string.rep(".", math.floor(now * 2) % 3 + 1)
        setText(progress.elapsed, elapsed)
        local detail = "Preparing your reply"
        if compacting then
            detail = "Summarizing older context to continue this conversation"
        end
        local activity
        if not sending and not compacting then
            for index = #(chat.activity or {}), 1, -1 do
                local tool = chat.activity[index]
                if tool.status == "running" then
                    activity = tool.label or tool.name
                    detail = activity
                    break
                end
            end
        end
        setText(progress.title, (activity or phase) .. dots)
        setText(progress.detail, detail)
        title = "Wisp AI - " .. (sending and "Sending" or phase) .. " " .. elapsed
    elseif chat then
        ns.workStarted[chat.id] = nil
    end
    setText(
        header.title,
        ns.db.minimized and (ns.unread and "Wisp AI - New reply" or title) or "Wisp AI"
    )
    replyGlow:SetShown(ns.db.minimized and ns.unread == true)
end

-- Returns the next transcript offset, including the working assistant row.
function ns.UI.Activity.LayoutProgress(y, width, showAuthor, visible)
    progress:SetShown(visible == true)
    if not visible then
        return y
    end
    if progress.showAuthor ~= showAuthor then
        progress.showAuthor = showAuthor
        progress.author:SetShown(showAuthor)
        progress:SetHeight(showAuthor and 54 or 34)
        progress.title:ClearAllPoints()
        progress.title:SetPoint("TOPLEFT", 0, showAuthor and -20 or 0)
        progress.title:SetPoint("RIGHT", -65, 0)
        progress.elapsed:ClearAllPoints()
        progress.elapsed:SetPoint("TOPRIGHT", -2, showAuthor and -20 or 0)
    end
    progress:SetWidth(width)
    if progress.y ~= y then
        progress.y = y
        progress:ClearAllPoints()
        progress:SetPoint("TOPLEFT", progress:GetParent(), "TOPLEFT", 0, -y)
    end
    y = y + progress:GetHeight()
    return y
end

function ns.UI.Activity.Tick(_, elapsed)
    if emptyState:IsShown() and emptyState.loading then
        for index, dot in ipairs(emptyState.dots) do
            dot:SetAlpha(0.3 + 0.7 * (0.5 + 0.5 * math.sin(GetTime() * 4 - index * 0.8)))
        end
    end
    if replyGlow:IsShown() then
        replyGlow:SetAlpha(0.65 + 0.25 * math.sin(GetTime() * math.pi))
    end
    progressTick = progressTick + elapsed
    if progressTick >= 0.25 then
        progressTick = 0
        ns.UI.Activity.Refresh(ns.Chat.Current())
    end
end

function ns.UI.Activity.Build(windowHeader, transcript, content)
    header = windowHeader
    local frame = header:GetParent()
    local chatPanel = transcript:GetParent()
    replyGlow = CreateFrame("Frame", "WispAIReplyGlow", header, "BackdropTemplate")
    replyGlow:SetPoint("TOPLEFT", frame, "TOPLEFT", -2, 2)
    replyGlow:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", 2, -2)
    replyGlow:SetBackdrop({
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        edgeSize = 20,
    })
    replyGlow:SetBackdropBorderColor(1, 0.78, 0.28, 1)
    replyGlow:EnableMouse(false)
    replyGlow:Hide()
    emptyState = CreateFrame("Frame", "WispAIChatPlaceholder", chatPanel)
    emptyState:SetAllPoints(transcript)
    emptyState:EnableMouse(false)
    emptyState.title = label(emptyState, "", GOLD)
    emptyState.title:SetPoint("CENTER", 0, 20)
    emptyState.title:SetJustifyH("CENTER")
    emptyState.detail = label(emptyState, "", MUTED)
    emptyState.detail:SetPoint("TOP", emptyState.title, "BOTTOM", 0, -10)
    emptyState.detail:SetPoint("LEFT", 20, 0)
    emptyState.detail:SetPoint("RIGHT", -20, 0)
    emptyState.detail:SetJustifyH("CENTER")
    emptyState.detail:SetWordWrap(true)
    emptyState.dots = {}
    for index = 1, 3 do
        local dot = label(emptyState, ".", GOLD)
        dot:SetFontObject("GameFontNormalLarge")
        dot:SetPoint("BOTTOM", emptyState.title, "TOP", (index - 2) * 12, 12)
        emptyState.dots[index] = dot
    end
    progress = CreateFrame("Frame", "WispAIProgress", content)
    progress:SetHeight(54)
    progress.author = label(progress, "Wisp AI", GOLD)
    progress.author:SetPoint("TOPLEFT", 0, 0)
    progress.title = label(progress, "", MUTED)
    progress.title:SetFontObject(ChatFontNormal)
    progress.title:SetPoint("TOPLEFT", 0, -20)
    progress.title:SetPoint("RIGHT", -65, 0)
    progress.title:SetWordWrap(false)
    progress.elapsed = label(progress, "", MUTED)
    progress.elapsed:SetPoint("TOPRIGHT", -2, -20)
    progress.detail = label(progress, "", MUTED)
    progress.detail:Hide()
    progress:EnableMouse(true)
    progress:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(progress.detail:GetText())
        GameTooltip:Show()
    end)
    progress:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
end
