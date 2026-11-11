local _, ns = ...
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, TEXT, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.TEXT, ns.UI.Widgets.MUTED
local refreshReferences = ns.UI.MessageFormat.RefreshReferences
local frame, header, body, sidebar, chatPanel, status, transcript, content, scrollBar, sessionTitle, send, mini, settings, contextMeter
local replyGlow, newMessages
local emptyState
local progress
local gear, fold, sessionsLabel, newSession, resize
local chatsTab, routinesTab
local function refreshProgress()
    local chat = ns.Chat.Current()
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
    progress:SetShown(working)
    local title = "Wisp AI"
    if working then
        local now = GetTime()
        ns.workStarted[chat.id] = ns.workStarted[chat.id] or now
        local seconds = math.max(0, math.floor(now - ns.workStarted[chat.id]))
        local elapsed = seconds < 60 and (seconds .. "s")
            or string.format("%dm %02ds", math.floor(seconds / 60), seconds % 60)
        local sending = false
        for _, pending in pairs(ns.pendingMessages or {}) do
            if pending.chat == chat.id and not pending.acknowledged then
                sending = true
                break
            end
        end
        local compacting = chat.usage and chat.usage.compacting
        local phase = sending and "Sending" or (compacting and "Compacting" or "Thinking")
        local dots = string.rep(".", math.floor(now * 2) % 3 + 1)
        setText(progress.elapsed, elapsed)
        local detail = sending
                and (seconds >= 15 and "Waiting for bridge confirmation" or "Delivering your message")
            or "Preparing your reply"
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
        title = "Wisp AI - " .. phase .. " " .. elapsed
    elseif chat then
        ns.workStarted[chat.id] = nil
    end
    setText(
        header.title,
        ns.db.minimized and (ns.unread and "Wisp AI - New reply" or title) or "Wisp AI"
    )
    replyGlow:SetShown(ns.db.minimized and ns.unread == true)
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
function ns.UI.RequestDeleteChat(id)
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            StaticPopup_Show("WISPAI_DELETE_CHAT", chat.title, nil, id)
            return
        end
    end
end
local sessionContent, sessionScroll
local sessionButtons, rows, scrollPositions = {}, {}, {}
local renderedChat = nil
local rendering, scrollRange = false, 0
local function layout()
    local expanded = not ns.db.minimized
    gear:SetShown(expanded)
    fold:SetShown(expanded)
    resize:SetShown(expanded)
    sessionsLabel:SetShown(ns.db.sidebar)
    newSession:SetShown(ns.db.sidebar)
    sessionScroll:SetShown(ns.db.sidebar)
    chatsTab:SetShown(ns.db.sidebar)
    routinesTab:SetShown(ns.db.sidebar)
    local width = ns.db.sidebar and 155 or 30
    sidebar:SetWidth(width)
    local arrow = ns.db.sidebar and "<" or ">"
    if fold.lastText ~= arrow then
        fold.lastText = arrow
        fold:SetText(arrow)
    end
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
function ns.UI.ScrollTranscript(delta)
    scrollBar:SetValue(math.max(0, math.min(scrollRange, scrollBar:GetValue() - delta * 45)))
end
local function renderTranscript(chat)
    local id = chat and chat.id or "empty"
    local switched = renderedChat ~= id
    local oldOffset = transcript:GetVerticalScroll()
    if switched and renderedChat then
        scrollPositions[renderedChat] =
            { offset = oldOffset, follow = scrollRange - oldOffset < 30 }
    end
    local follow = scrollRange - oldOffset < 30
    if switched then
        local saved = scrollPositions[id]
        oldOffset = saved and saved.offset or 0
        follow = not saved or saved.follow
    end
    local width = math.max(100, transcript:GetWidth() - 6)
    local y, used = 0, {}
    local previousSpeaker
    for index, message in ipairs(ns.UI.DisplayMessages(chat)) do
        if message.role ~= "tool" or ns.db.showTools then
            local key = id .. ":" .. (message.id or tostring(index))
            local row = rows[key]
            if not row then
                row = ns.UI.MakeMessageRow(content)
                rows[key] = row
            end
            used[key] = true
            local speaker = ns.UI.MessageSpeaker(message)
            y = y + ns.UI.MessageGap(previousSpeaker, speaker)
            local showAuthor = speaker ~= "assistant" or previousSpeaker ~= speaker
            ns.UI.RenderMessageRow(row, chat, message, width, showAuthor)
            previousSpeaker = speaker
            ns.UI.PositionMessageRow(row, content, y, width)
            if not row:IsShown() then
                row:Show()
            end
            if ns.Transport.RecordFirstText then
                ns.Transport.RecordFirstText(chat, message, row)
            end
            y = y + row.height
        end
    end
    if chat and chat.status == "working" then
        local showAuthor = previousSpeaker ~= "assistant"
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
            progress:SetPoint("TOPLEFT", content, "TOPLEFT", 0, -y)
        end
        y = y + progress:GetHeight()
    end
    for key, row in pairs(rows) do
        if not used[key] and row:IsShown() then
            row:Hide()
        end
    end
    content:SetWidth(width)
    content:SetHeight(math.max(1, y))
    scrollRange = math.max(0, y - transcript:GetHeight())
    scrollBar:SetMinMaxValues(0, math.max(1, scrollRange))
    scrollBar:EnableMouse(scrollRange > 0)
    scrollBar:SetAlpha(scrollRange > 0 and 1 or 0.35)
    local position = follow and scrollRange or math.min(oldOffset, scrollRange)
    scrollBar:SetValue(position)
    transcript:SetVerticalScroll(position)
    ns.UI.UpdateNewMessages(newMessages, chat, follow, switched)
    renderedChat = id
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
    setText(
        status,
        ns.exhausted and "Channels exhausted: /reload"
            or (ns.connected and "Connected" or "Waiting for bridge...")
    )
    refreshProgress()
    ns.UI.RefreshModelControls()
    local usage = chat and chat.usage
    local window = ns.contextPolicy and ns.contextPolicy.windowTokens
    local measured = usage and usage.contextTokens
    local meterText = usage and usage.compacting and "Compacting..."
        or (measured and window and string.format("Context ~%.0f%%", measured / window * 100))
        or "Context --"
    setText(contextMeter.text, meterText)
    setText(sessionTitle, chat and chat.title or "New conversation")
    layout()
    local sessionCount = 0
    local used = {}
    local ordered, positions = {}, {}
    for index, session in ipairs(ns.chats) do
        ordered[#ordered + 1] = session
        positions[session.id] = index
    end
    table.sort(ordered, function(a, b)
        local aTime, bTime = a.lastActivityAt or 0, b.lastActivityAt or 0
        if aTime == bTime then
            return positions[a.id] < positions[b.id]
        end
        return aTime > bTime
    end)
    if ns.sidebarTab == "routines" then
        ordered = {}
        if ns.sidebarRoutine then
            for index = #(ns.routineRuns or {}), 1, -1 do
                local run = ns.routineRuns[index]
                if run.routineId == ns.sidebarRoutine and run.status ~= "no_tip" then
                    local stamp = date and date("%d/%m %H:%M", run.startedAt / 1000) or run.event
                    ordered[#ordered + 1] = {
                        id = run.id,
                        title = stamp .. " - " .. run.event,
                        status = run.status,
                        runEntry = true,
                    }
                end
            end
        else
            for _, routine in ipairs(ns.routines or {}) do
                ordered[#ordered + 1] = {
                    id = "routine-header:" .. routine.id,
                    title = routine.title,
                    status = routine.enabled and "Active" or "Paused",
                    routine = routine,
                }
            end
        end
        if #ordered == 0 then
            ordered[1] = {
                id = "routine-empty",
                title = ns.sidebarRoutine and "No runs yet" or "Ask Wisp in chat",
                status = ns.sidebarRoutine and "Waiting for an event" or "to create a routine",
                emptyEntry = true,
            }
        end
    end
    for _, session in ipairs(ordered) do
        if
            ns.sidebarTab == "routines"
            or (not session.inline and not session.proactive and not session.routineId)
        then
            sessionCount = sessionCount + 1
            local index = sessionCount
            local b = sessionButtons[session.id]
            if not b then
                b = CreateFrame("Button", nil, sessionContent, "BackdropTemplate")
                b:SetSize(139, 42)
                b.title = label(b, "")
                b.title:SetPoint("TOPLEFT", 7, -7)
                b.title:SetPoint("RIGHT", -28, 0)
                b.title:SetWordWrap(false)
                b.info = label(b, "", MUTED)
                b.info:SetPoint("TOPLEFT", 7, -24)
                b:SetScript("OnClick", function(self)
                    if self.routine then
                        ns.sidebarRoutine = self.routine.id
                        ns.UI.Refresh()
                    elseif not self.emptyEntry and self.runStatus ~= "no_tip" then
                        ns.Chat.Select(self.chatId)
                    end
                end)
                b:SetScript("OnEnter", function(self)
                    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
                    GameTooltip:SetText(self.fullTitle)
                    GameTooltip:Show()
                end)
                b:SetScript("OnLeave", function()
                    GameTooltip:Hide()
                end)
                b.delete = button(b, "x", 20, function()
                    if b.routine then
                        ns.Transport.Send({
                            type = "routine_action",
                            data = {
                                operation = b.routine.enabled and "pause" or "resume",
                                id = b.routine.id,
                            },
                            context = ns.Character.Capture({ "character" }),
                        })
                    else
                        ns.UI.RequestDeleteChat(b.chatId)
                    end
                end)
                b.delete:SetSize(20, 20)
                b.delete:SetPoint("TOPRIGHT", -3, -3)
                b.delete:SetScript("OnEnter", function(self)
                    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
                    GameTooltip:SetText(
                        b.routine and "Pause / resume routine" or "Delete conversation"
                    )
                    GameTooltip:Show()
                end)
                b.delete:SetScript("OnLeave", function()
                    GameTooltip:Hide()
                end)
                sessionButtons[session.id] = b
            end
            used[session.id] = true
            b.chatId, b.fullTitle = session.id, session.title
            b.routine, b.emptyEntry, b.runStatus =
                session.routine, session.emptyEntry, session.runEntry and session.status or nil
            b.delete:SetShown(not session.emptyEntry and not session.runEntry)
            local deleteText = session.routine and (session.routine.enabled and "||" or ">") or "x"
            if b.deleteText ~= deleteText then
                b.deleteText = deleteText
                b.delete:SetText(deleteText)
            end
            if b.index ~= index then
                b.index = index
                b:ClearAllPoints()
                b:SetPoint("TOPLEFT", 0, -(index - 1) * 44)
            end
            setText(b.title, session.title)
            setText(
                b.info,
                session.status == "working" and "Working..."
                    or (session.runEntry and (session.status == "no_tip" and "No updates" or session.status))
                    or ((session.routine or session.emptyEntry) and session.status)
                    or (session.unread and "Unread" or "Conversation")
            )
            local selected = session.id == ns.active
            if b.selected ~= selected then
                b.selected = selected
                b.title:SetTextColor(unpack(selected and GOLD or TEXT))
                if selected then
                    box(b, { 0.25, 0.21, 0.14, 1 }, 8)
                else
                    b:SetBackdrop(nil)
                end
            end
            if not b:IsShown() then
                b:Show()
            end
        end
    end
    sessionContent:SetHeight(math.max(1, sessionCount * 44))
    for id, b in pairs(sessionButtons) do
        if not used[id] and b:IsShown() then
            b:Hide()
        end
    end
    renderTranscript(chat)
    local sendText = chat and chat.status == "working" and "Stop" or "Send"
    if send.lastText ~= sendText then
        send.lastText = sendText
        send:SetText(sendText)
    end
    rendering = false
    if ns.Inline.RefreshInline then
        ns.Inline.RefreshInline()
    end
end
function ns.UI.BuildUI()
    refreshReferences()
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
    sidebar = CreateFrame("Frame", nil, body, "BackdropTemplate")
    sidebar:SetPoint("TOPLEFT")
    sidebar:SetPoint("BOTTOMLEFT")
    sidebar:SetWidth(155)
    box(sidebar, { 0.10, 0.085, 0.065, 1 }, 8)
    sessionsLabel = label(sidebar, "Sessions", GOLD)
    sessionsLabel:SetPoint("TOPLEFT", 11, -12)
    newSession = button(sidebar, "+", 25, function()
        ns.Chat.NewChat()
    end)
    newSession:SetPoint("TOPRIGHT", -33, -6)
    fold = CreateFrame("Button", "WispAISidebarToggle", sidebar, "UIPanelButtonTemplate")
    fold:SetSize(22, 24)
    fold:SetPoint("TOPRIGHT", -5, -6)
    fold:SetScript("OnClick", function()
        ns.db.sidebar = not ns.db.sidebar
        ns.UI.Refresh()
    end)
    fold:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText(ns.db.sidebar and "Collapse sessions" or "Expand sessions")
        GameTooltip:Show()
    end)
    fold:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    sessionScroll = CreateFrame("ScrollFrame", nil, sidebar)
    chatsTab = button(sidebar, "Chats", 64, function()
        ns.sidebarTab = "chats"
        ns.UI.Refresh()
    end)
    chatsTab:SetPoint("TOPLEFT", 6, -35)
    routinesTab = button(sidebar, "Routines", 75, function()
        ns.sidebarTab, ns.sidebarRoutine = "routines", nil
        ns.UI.Refresh()
    end)
    routinesTab:SetPoint("LEFT", chatsTab, "RIGHT", 2, 0)
    sessionScroll:SetPoint("TOPLEFT", 7, -64)
    sessionScroll:SetPoint("BOTTOMRIGHT", -7, 8)
    sessionContent = CreateFrame("Frame", nil, sessionScroll)
    sessionContent:SetSize(139, 1)
    sessionScroll:SetScrollChild(sessionContent)
    sessionScroll:EnableMouseWheel(true)
    sessionScroll:SetScript("OnMouseWheel", function(self, delta)
        self:SetVerticalScroll(
            math.max(
                0,
                math.min(self:GetVerticalScrollRange(), self:GetVerticalScroll() - delta * 35)
            )
        )
    end)
    chatPanel = CreateFrame("Frame", nil, body)
    sessionTitle = label(chatPanel, "New conversation", MUTED)
    sessionTitle:SetPoint("TOPLEFT", 12, -9)
    sessionTitle:SetPoint("RIGHT", -12, 0)
    sessionTitle:SetWordWrap(false)
    transcript = CreateFrame("ScrollFrame", nil, chatPanel)
    transcript:SetPoint("TOPLEFT", 13, -34)
    transcript:SetPoint("BOTTOMRIGHT", -31, 104)
    content = CreateFrame("Frame", nil, transcript)
    content:SetSize(360, 1)
    transcript:SetScrollChild(content)
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
    scrollBar = CreateFrame("Slider", "WispAITranscriptScrollBar", chatPanel, "BackdropTemplate")
    scrollBar:SetOrientation("VERTICAL")
    scrollBar:SetPoint("TOPRIGHT", -10, -34)
    scrollBar:SetPoint("BOTTOMRIGHT", -10, 104)
    scrollBar:SetWidth(14)
    box(scrollBar, { 0.08, 0.07, 0.05, 1 }, 8)
    scrollBar:SetMinMaxValues(0, 1)
    scrollBar:SetValueStep(1)
    if scrollBar.SetObeyStepOnDrag then
        scrollBar:SetObeyStepOnDrag(false)
    end
    scrollBar:SetThumbTexture("Interface\\Buttons\\UI-ScrollBar-Knob")
    scrollBar:GetThumbTexture():SetSize(14, 28)
    scrollBar:SetScript("OnValueChanged", function(_, value)
        transcript:SetVerticalScroll(value)
        if not rendering and newMessages and value >= scrollRange - 30 then
            newMessages.pending = false
            newMessages:Hide()
        end
    end)
    newMessages = button(chatPanel, "New messages v", 140, function()
        scrollBar:SetValue(scrollRange)
        newMessages.pending = false
        newMessages:Hide()
    end)
    newMessages:SetPoint("BOTTOM", transcript, "BOTTOM", 0, 8)
    newMessages:SetFrameLevel(transcript:GetFrameLevel() + 10)
    newMessages:Hide()
    transcript:EnableMouseWheel(true)
    transcript:SetScript("OnMouseWheel", function(_, delta)
        scrollBar:SetValue(math.max(0, math.min(scrollRange, scrollBar:GetValue() - delta * 45)))
    end)
    local progressTick = 0
    frame:SetScript("OnUpdate", function(_, elapsed)
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
            refreshProgress()
        end
    end)
    local inputBox = CreateFrame("Frame", nil, chatPanel, "BackdropTemplate")
    inputBox:SetPoint("BOTTOMLEFT", 9, 22)
    inputBox:SetPoint("BOTTOMRIGHT", -9, 22)
    inputBox:SetHeight(78)
    box(inputBox, { 0.045, 0.04, 0.03, 1 }, 9)
    local inputScroll = CreateFrame("ScrollFrame", "WispAIInputScroll", inputBox)
    inputScroll:SetPoint("TOPLEFT", 10, -7)
    inputScroll:SetPoint("BOTTOMRIGHT", -10, 28)
    inputScroll:SetClipsChildren(true)
    ns.draft = CreateFrame("EditBox", "WispAIInput", inputScroll)
    ns.draft:SetMultiLine(true)
    ns.draft:SetAutoFocus(false)
    ns.draft:SetFontObject(ChatFontNormal)
    ns.draft:SetMaxLetters(4000)
    ns.draft:SetPoint("TOPLEFT", inputScroll, "TOPLEFT")
    ns.draft:SetSize(inputScroll:GetWidth(), 1)
    inputScroll:SetScrollChild(ns.draft)
    local inputBar = CreateFrame("Slider", "WispAIInputScrollBar", inputBox, "BackdropTemplate")
    inputBar:SetOrientation("VERTICAL")
    inputBar:SetPoint("TOPLEFT", inputScroll, "TOPRIGHT", 1, 0)
    inputBar:SetPoint("BOTTOMLEFT", inputScroll, "BOTTOMRIGHT", 1, 0)
    inputBar:SetWidth(8)
    inputBar:SetFrameLevel(inputScroll:GetFrameLevel() + 1)
    box(inputBar, { 0.08, 0.07, 0.05, 1 }, 2)
    inputBar:SetMinMaxValues(0, 0)
    inputBar:SetValueStep(1)
    if inputBar.SetObeyStepOnDrag then
        inputBar:SetObeyStepOnDrag(false)
    end
    inputBar:SetThumbTexture("Interface\\Buttons\\UI-ScrollBar-Knob")
    inputBar:GetThumbTexture():SetSize(8, 16)
    inputBar:SetScript("OnValueChanged", function(_, value)
        inputScroll:SetVerticalScroll(value)
    end)
    inputBar:Hide()
    local function scrollInput(value)
        local range = inputScroll:GetVerticalScrollRange()
        inputBar:SetMinMaxValues(0, range)
        inputBar:SetShown(range > 0)
        inputBar:SetValue(math.max(0, math.min(range, value)))
    end
    inputScroll:SetScript("OnVerticalScroll", function(_, value)
        if inputBar:GetValue() ~= value then
            inputBar:SetValue(value)
        end
    end)
    local function revealCursor(_, _, y, _, height)
        inputScroll:UpdateScrollChildRect()
        local top = -y
        local offset = inputScroll:GetVerticalScroll()
        if top < offset then
            scrollInput(top)
        elseif top + height > offset + inputScroll:GetHeight() then
            scrollInput(top + height - inputScroll:GetHeight())
        end
    end
    ns.draft:SetScript("OnCursorChanged", revealCursor)
    ns.draft:SetScript("OnTextChanged", function(self)
        inputScroll:UpdateScrollChildRect()
        scrollInput(self:GetText() == "" and 0 or inputScroll:GetVerticalScroll())
    end)
    inputScroll:SetScript("OnSizeChanged", function(_, width)
        ns.draft:SetWidth(width)
        inputScroll:UpdateScrollChildRect()
        scrollInput(inputScroll:GetVerticalScroll())
    end)
    inputScroll:SetScript("OnScrollRangeChanged", function()
        scrollInput(inputScroll:GetVerticalScroll())
    end)
    inputScroll:EnableMouseWheel(true)
    inputScroll:SetScript("OnMouseWheel", function(_, delta)
        scrollInput(inputScroll:GetVerticalScroll() - delta * 32)
    end)
    inputScroll:EnableMouse(true)
    inputScroll:SetScript("OnMouseDown", function()
        ns.draft:SetFocus()
    end)
    ns.draft:SetScript("OnEnterPressed", function(self)
        if IsShiftKeyDown() then
            self:Insert("\n")
        else
            ns.Chat.Submit()
        end
    end)
    ns.draft:SetScript("OnEscapePressed", function(self)
        self:ClearFocus()
        ns.UI.SetMinimized(true)
    end)
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
    send = button(inputBox, "Send", 75, function()
        local chat = ns.Chat.Current()
        if chat and chat.status == "working" then
            ns.Transport.Send({ type = "cancel", chat = ns.active })
        else
            ns.Chat.Submit()
        end
    end)
    send:SetPoint("BOTTOMRIGHT", -7, 5)
    local modelPicker = ns.UI.CreateModelControls(
        inputBox,
        "WispAIChatModelControls",
        ns.Chat.Current,
        function()
            ns.Chat.NewChat()
            return ns.Chat.Current()
        end
    )
    modelPicker:SetPoint("BOTTOMLEFT", 10, 5)
    modelPicker.composer, modelPicker.send = inputBox, send
    modelPicker.inputScroll = inputScroll
    modelPicker.transcript, modelPicker.scrollBar = transcript, scrollBar
    status = label(chatPanel, "Waiting for bridge...", MUTED)
    status:SetPoint("BOTTOMLEFT", 12, 6)
    contextMeter = CreateFrame("Button", "WispAIContextUsage", chatPanel)
    contextMeter:SetSize(112, 16)
    contextMeter:SetPoint("BOTTOMRIGHT", -22, 3)
    contextMeter.text = label(contextMeter, "Context --", MUTED)
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
    if ChatFrameUtil and ChatFrameUtil.InsertLink then
        hooksecurefunc(ChatFrameUtil, "InsertLink", function(link)
            if ns.draft:HasFocus() then
                ns.draft:Insert(link)
            end
        end)
    end
    local itemEvents = CreateFrame("Frame")
    itemEvents:RegisterEvent("GET_ITEM_INFO_RECEIVED")
    itemEvents:RegisterEvent("QUEST_LOG_UPDATE")
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
