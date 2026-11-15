local _, ns = ...
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, TEXT, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.TEXT, ns.UI.Widgets.MUTED
local MIN_WIDTH, MAX_WIDTH, MIN_CHAT_WIDTH = 155, 330, 260
local PAGE_SIZE, RUN_HEIGHT, SESSION_HEIGHT = 5, 24, 44
local sidebar, fold, sessionsLabel, newSession, chatsTab, routinesTab
local sessionContent, sessionScroll, divider
local historyFrame, historyList, historyThumb, historyEmpty, loadMore
local history, historyRequest = nil, 0
local runButtons = {}
local sessionButtons = {}
local sidebarWidth, maxWidth, dragX, dragWidth

local function scrollSessions(delta)
    sessionScroll:SetVerticalScroll(
        math.max(
            0,
            math.min(
                sessionScroll:GetVerticalScrollRange(),
                sessionScroll:GetVerticalScroll() - delta * 35
            )
        )
    )
end

local function routineRuns(id)
    local runs = {}
    local recent = ns.routineRuns or {}
    for index = #recent, 1, -1 do
        local run = recent[index]
        if run.routineId == id and run.status ~= "no_tip" then
            runs[#runs + 1] = run
        end
    end
    return runs
end

local function newHistory(id)
    return { id = id, offset = 0, limit = PAGE_SIZE, recent = {} }
end

local function requestHistory(current, before)
    historyRequest = historyRequest + 1
    local requestId = tostring(historyRequest)
    current.pending = requestId
    current.attempted = true
    ns.Transport.Send({
        type = "routine_history",
        key = current.id,
        requestId = requestId,
        data = before and { before = before } or nil,
    })
    C_Timer.After(15, function()
        if history == current and current.pending == requestId then
            current.pending = nil
            ns.UI.Sidebar.Refresh()
        end
    end)
end

local function updateHistory(current)
    local page = ns.routineHistory
    local received = current.pending
        and type(page) == "table"
        and page.requestId == current.pending
        and page.routineId == current.id
    if received then
        local firstPage = not current.runs
        local loaded = current.runs and #current.runs or 0
        current.runs = current.runs or {}
        for _, run in ipairs(page.runs or {}) do
            current.runs[#current.runs + 1] = run
        end
        current.next, current.pending = page.next, nil
        current.offset = loaded > 0 and loaded or 0
        if firstPage and current.openLatest and current.runs[1] then
            local active = current.openLatest.active
            C_Timer.After(0, function()
                if
                    history == current
                    and ns.sidebarTab == "routines"
                    and ns.sidebarRoutine == current.id
                    and ns.active == active
                then
                    ns.Chat.Select(current.runs[1].id, current.id)
                end
            end)
        end
        current.openLatest = nil
    end
    if current.recentSource ~= ns.routineRuns or received then
        current.recentSource = ns.routineRuns
        current.recent = routineRuns(current.id)
        if current.runs then
            -- Keep the latest runs and status updates from the live snapshot.
            -- The cursor still points to the end of the pages from the bridge.
            local known, merged = {}, {}
            for _, run in ipairs(current.runs) do
                known[run.id] = run
            end
            local newest = current.runs[1]
            local newestIndex
            for index, run in ipairs(current.recent) do
                if newest and run.id == newest.id then
                    newestIndex = index
                    break
                end
            end
            for index, run in ipairs(current.recent) do
                if known[run.id] then
                    known[run.id] = run
                elseif
                    not newest
                    or (newestIndex and index < newestIndex)
                    or (not newestIndex and run.startedAt > newest.startedAt)
                then
                    merged[#merged + 1] = run
                end
            end
            if current.offset > 0 then
                current.offset = current.offset + #merged
            end
            for _, run in ipairs(current.runs) do
                merged[#merged + 1] = known[run.id]
            end
            current.runs = merged
        end
    end
    if ns.routineHistory and not current.attempted and ns.db.sidebar and not ns.db.minimized then
        requestHistory(current)
    end
end

-- Reuse five widgets as the user scrolls through the loaded runs.
local function renderRuns()
    local runs = history.runs or history.recent
    local loaded = history.runs and #runs or math.min(history.limit, #runs)
    local maxOffset = math.max(0, loaded - PAGE_SIZE)
    history.offset = math.max(0, math.min(maxOffset, history.offset))
    local count = math.min(PAGE_SIZE, loaded)
    for index, row in ipairs(runButtons) do
        local run = runs[history.offset + index]
        local visible = index <= count
        row:SetShown(visible)
        if visible then
            row.chatId = run.id
            local stamp = date and date("%d/%m %H:%M", run.startedAt / 1000) or run.event
            local title = date and (stamp .. " - " .. run.event) or stamp
            row.fullTitle = title .. "\n" .. run.status
            setText(row.title, title)
            local selected = run.id == ns.active
            if row.selected ~= selected then
                row.selected = selected
                row.title:SetTextColor(unpack(selected and GOLD or TEXT))
                if selected then
                    box(row, { 0.25, 0.21, 0.14, 1 }, 8)
                else
                    row:SetBackdrop(nil)
                end
            end
        else
            row.chatId = nil
        end
    end
    historyThumb:SetShown(maxOffset > 0)
    if maxOffset > 0 then
        local height = count * RUN_HEIGHT
        local thumbHeight = math.max(12, height * count / loaded)
        historyThumb:SetHeight(thumbHeight)
        historyThumb:SetPoint("TOPRIGHT", -2, -(height - thumbHeight) * history.offset / maxOffset)
    end
end

local function layoutHistory(y)
    updateHistory(history)
    local runs = history.runs or history.recent
    local canLoad = history.pending
        or (history.runs and history.next)
        or (not history.runs and (ns.routineHistory or #runs > history.limit))
    local listHeight = math.max(1, math.min(PAGE_SIZE, #runs)) * RUN_HEIGHT
    historyFrame:SetPoint("TOPLEFT", sessionContent, "TOPLEFT", 9, -y)
    historyFrame:SetPoint("TOPRIGHT", sessionContent, "TOPRIGHT", 0, -y)
    historyList:SetHeight(listHeight)
    historyEmpty:SetShown(#runs == 0)
    local emptyText = history.pending and "Loading runs..."
        or (ns.routineHistory and not history.runs and "Could not load runs")
        or "No runs yet"
    setText(historyEmpty, emptyText)
    loadMore:SetShown(canLoad and (#runs > 0 or not history.pending))
    loadMore:SetEnabled(not history.pending)
    setText(loadMore, history.pending and "Loading..." or "Load more")
    local height = listHeight + (loadMore:IsShown() and RUN_HEIGHT or 0) + 3
    historyFrame:SetHeight(height)
    historyFrame:Show()
    renderRuns()
    return height
end

function ns.UI.RequestDeleteChat(id)
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            StaticPopup_Show("WISPAI_DELETE_CHAT", chat.title, nil, id)
            return
        end
    end
end

-- Returns the sidebar width so the window can anchor the conversation panel.
function ns.UI.Sidebar.Layout(bodyWidth)
    fold:SetShown(not ns.db.minimized)
    sessionsLabel:SetShown(ns.db.sidebar)
    newSession:SetShown(ns.db.sidebar)
    sessionScroll:SetShown(ns.db.sidebar)
    chatsTab:SetShown(ns.db.sidebar)
    routinesTab:SetShown(ns.db.sidebar)
    divider:SetShown(ns.db.sidebar and not ns.db.minimized)
    maxWidth = math.max(MIN_WIDTH, math.min(MAX_WIDTH, bodyWidth - MIN_CHAT_WIDTH))
    local preferredWidth = dragWidth or ns.db.sidebarWidth
    if not ns.Shared.Numbers.IsFinite(preferredWidth) then
        preferredWidth = MIN_WIDTH
    end
    local width = ns.db.sidebar and math.max(MIN_WIDTH, math.min(maxWidth, preferredWidth)) or 30
    if width ~= sidebarWidth then
        sidebarWidth = width
        sidebar:SetWidth(width)
        sessionContent:SetWidth(math.max(1, width - 16))
    end
    local arrow = ns.db.sidebar and "<" or ">"
    if fold.lastText ~= arrow then
        fold.lastText = arrow
        fold:SetText(arrow)
    end
    return width
end

function ns.UI.Sidebar.Refresh()
    local y = 0
    local used = {}
    local ordered, positions = {}, {}
    if ns.sidebarTab == "routines" then
        for _, routine in ipairs(ns.routines or {}) do
            ordered[#ordered + 1] = {
                id = "routine-header:" .. routine.id,
                title = routine.title,
                status = routine.enabled and "Active" or "Paused",
                routine = routine,
            }
        end
        if #ordered == 0 then
            ordered[1] = {
                id = "routine-empty",
                title = "Ask Wisp in chat",
                status = "to create a routine",
                emptyEntry = true,
            }
        end
    else
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
    end
    local historyShown = false
    for _, session in ipairs(ordered) do
        local b = sessionButtons[session.id]
        if not b then
            b = CreateFrame("Button", nil, sessionContent, "BackdropTemplate")
            b:SetHeight(SESSION_HEIGHT - 2)
            b.title = label(b, "")
            b.title:SetPoint("TOPLEFT", 7, -7)
            b.title:SetWordWrap(false)
            b.info = label(b, "", MUTED)
            b.info:SetPoint("TOPLEFT", 7, -24)
            b:SetScript("OnClick", function(self)
                if self.routine then
                    local id = self.routine.id
                    if ns.sidebarRoutine == id then
                        ns.sidebarRoutine = nil
                        ns.UI.Refresh()
                    else
                        ns.sidebarRoutine = id
                        local latest = routineRuns(id)[1]
                        if latest then
                            ns.Chat.Select(latest.id, id)
                        else
                            history = newHistory(id)
                            history.openLatest = { active = ns.active }
                            ns.UI.Refresh()
                        end
                    end
                elseif not self.emptyEntry then
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
            b.caret = label(b, "", GOLD)
            b.caret:SetPoint("RIGHT", b.delete, "LEFT", -3, 0)
            b.delete:SetScript("OnEnter", function(self)
                GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
                GameTooltip:SetText(b.routine and "Pause / resume routine" or "Delete conversation")
                GameTooltip:Show()
            end)
            b.delete:SetScript("OnLeave", function()
                GameTooltip:Hide()
            end)
            sessionButtons[session.id] = b
        end
        used[session.id] = true
        b.chatId, b.fullTitle = session.id, session.title
        b.routine, b.emptyEntry = session.routine, session.emptyEntry
        b.delete:SetShown(not session.emptyEntry)
        local deleteText = session.routine and (session.routine.enabled and "||" or ">") or "x"
        if b.deleteText ~= deleteText then
            b.deleteText = deleteText
            b.delete:SetText(deleteText)
        end
        if b.y ~= y then
            b.y = y
            b:ClearAllPoints()
            b:SetPoint("TOPLEFT", 0, -y)
            b:SetPoint("TOPRIGHT", 0, -y)
        end
        local expanded = session.routine and session.routine.id == ns.sidebarRoutine
        if b.hasCaret ~= (session.routine ~= nil) then
            b.hasCaret = session.routine ~= nil
            b.title:SetPoint("TOPRIGHT", b.hasCaret and -42 or -28, -7)
        end
        setText(b.caret, session.routine and (expanded and "v" or ">") or "")
        setText(b.title, (session.title or ""):gsub("[\r\n]+", " "))
        setText(
            b.info,
            session.status == "working" and "Working..."
                or ((session.routine or session.emptyEntry) and session.status)
                or (session.unread and "Unread" or "Conversation")
        )
        local selected = expanded or session.id == ns.active
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
        y = y + SESSION_HEIGHT
        if expanded then
            if not history or history.id ~= session.routine.id then
                history = newHistory(session.routine.id)
            end
            y = y + layoutHistory(y)
            historyShown = true
        end
    end
    if not historyShown then
        historyFrame:Hide()
        if ns.sidebarTab == "routines" then
            history = nil
        end
    end
    sessionContent:SetHeight(math.max(1, y))
    if sessionScroll:GetVerticalScroll() > sessionScroll:GetVerticalScrollRange() then
        sessionScroll:SetVerticalScroll(sessionScroll:GetVerticalScrollRange())
    end
    for id, b in pairs(sessionButtons) do
        if not used[id] and b:IsShown() then
            b:Hide()
        end
    end
end

function ns.UI.Sidebar.Build(body, onResize, onResizeDone)
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
    sidebar = CreateFrame("Frame", nil, body, "BackdropTemplate")
    sidebar:SetPoint("TOPLEFT")
    sidebar:SetPoint("BOTTOMLEFT")
    sidebar:SetWidth(MIN_WIDTH)
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
    divider = CreateFrame("Button", "WispAISidebarResize", sidebar)
    divider:SetPoint("TOPRIGHT", 0, -3)
    divider:SetPoint("BOTTOMRIGHT", 0, 3)
    divider:SetWidth(8)
    local grip = divider:CreateTexture(nil, "ARTWORK")
    grip:SetSize(2, 22)
    grip:SetPoint("CENTER")
    grip:SetColorTexture(unpack(MUTED))
    divider:SetScript("OnEnter", function(self)
        grip:SetColorTexture(unpack(GOLD))
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText("Drag to resize sessions")
        GameTooltip:Show()
    end)
    divider:SetScript("OnLeave", function()
        grip:SetColorTexture(unpack(MUTED))
        GameTooltip:Hide()
    end)
    divider:RegisterForDrag("LeftButton")
    divider:SetScript("OnDragStart", function(self)
        local origin = GetCursorPosition()
        local initialWidth, scale = sidebarWidth, sidebar:GetEffectiveScale()
        dragX, dragWidth = origin, initialWidth
        GameTooltip:Hide()
        self:SetScript("OnUpdate", function()
            local x = GetCursorPosition()
            local width =
                math.max(MIN_WIDTH, math.min(maxWidth, initialWidth + (x - dragX) / scale))
            if dragWidth ~= width then
                dragWidth = width
                onResize()
            end
        end)
    end)
    local function finishResize(self)
        if dragX then
            ns.db.sidebarWidth = dragWidth
            dragX, dragWidth = nil, nil
            self:SetScript("OnUpdate", nil)
            return true
        end
    end
    divider:SetScript("OnDragStop", function(self)
        if finishResize(self) then
            onResizeDone()
        end
    end)
    divider:SetScript("OnHide", finishResize)
    sessionScroll = CreateFrame("ScrollFrame", nil, sidebar)
    chatsTab = button(sidebar, "Chats", 64, function()
        ns.sidebarTab = "chats"
        sessionScroll:SetVerticalScroll(0)
        ns.UI.Refresh()
    end)
    chatsTab:SetPoint("TOPLEFT", 6, -35)
    routinesTab = button(sidebar, "Routines", 75, function()
        ns.sidebarTab = "routines"
        sessionScroll:SetVerticalScroll(0)
        ns.UI.Refresh()
    end)
    routinesTab:SetPoint("LEFT", chatsTab, "RIGHT", 2, 0)
    sessionScroll:SetPoint("TOPLEFT", 7, -64)
    sessionScroll:SetPoint("BOTTOMRIGHT", -9, 8)
    sessionContent = CreateFrame("Frame", nil, sessionScroll)
    sessionContent:SetSize(139, 1)
    sessionScroll:SetScrollChild(sessionContent)
    sessionScroll:SetClipsChildren(true)
    sessionScroll:EnableMouseWheel(true)
    sessionScroll:SetScript("OnMouseWheel", function(_, delta)
        scrollSessions(delta)
    end)
    historyFrame = CreateFrame("Frame", nil, sessionContent)
    historyList = CreateFrame("Frame", nil, historyFrame)
    historyList:SetPoint("TOPLEFT")
    historyList:SetPoint("TOPRIGHT")
    historyList:EnableMouseWheel(true)
    historyList:SetScript("OnMouseWheel", function(_, delta)
        local previous = history.offset
        history.offset = math.floor(history.offset - delta)
        renderRuns()
        if history.offset == previous then
            scrollSessions(delta)
        end
    end)
    historyThumb = historyList:CreateTexture(nil, "OVERLAY")
    historyThumb:SetWidth(2)
    historyThumb:SetColorTexture(unpack(MUTED))
    historyEmpty = label(historyList, "", MUTED)
    historyEmpty:SetPoint("TOPLEFT", 7, -5)
    for index = 1, PAGE_SIZE do
        local row = CreateFrame("Button", nil, historyList, "BackdropTemplate")
        row:SetHeight(RUN_HEIGHT)
        row:SetPoint("TOPLEFT", 0, -(index - 1) * RUN_HEIGHT)
        row:SetPoint("TOPRIGHT", -6, -(index - 1) * RUN_HEIGHT)
        row.title = label(row, "")
        row.title:SetPoint("LEFT", 7, 0)
        row.title:SetPoint("RIGHT", -5, 0)
        row.title:SetWordWrap(false)
        row:SetScript("OnClick", function(self)
            ns.Chat.Select(self.chatId, history.id)
        end)
        row:SetScript("OnEnter", function(self)
            GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
            GameTooltip:SetText(self.fullTitle)
            GameTooltip:Show()
        end)
        row:SetScript("OnLeave", function()
            GameTooltip:Hide()
        end)
        runButtons[index] = row
    end
    loadMore = button(historyFrame, "Load more", 100, function()
        if ns.routineHistory then
            requestHistory(history, history.next)
        else
            history.offset = history.limit
            history.limit = history.limit + PAGE_SIZE
        end
        ns.UI.Sidebar.Refresh()
    end)
    loadMore:SetPoint("TOPLEFT", historyList, "BOTTOMLEFT", 0, 0)
    historyFrame:Hide()
end
