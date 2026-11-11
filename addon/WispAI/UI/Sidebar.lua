local _, ns = ...
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, TEXT, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.TEXT, ns.UI.Widgets.MUTED
local sidebar, fold, sessionsLabel, newSession, chatsTab, routinesTab
local sessionContent, sessionScroll
local sessionButtons = {}

function ns.UI.RequestDeleteChat(id)
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            StaticPopup_Show("WISPAI_DELETE_CHAT", chat.title, nil, id)
            return
        end
    end
end

-- Returns the sidebar width so the window can anchor the conversation panel.
function ns.UI.Sidebar.Layout()
    fold:SetShown(not ns.db.minimized)
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
    return width
end

function ns.UI.Sidebar.Refresh()
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
end
