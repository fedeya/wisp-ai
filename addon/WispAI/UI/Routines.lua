local _, ns = ...
local widgets = ns.UI.Widgets
local COLORS, FONTS = widgets.COLORS, widgets.FONTS
local label, setText, box, button = widgets.Label, widgets.SetText, widgets.Box, widgets.Button
local TEXT, MUTED, ACCENT = widgets.TEXT, widgets.MUTED, widgets.ACCENT
local PAGE_INSET, CARD_HEIGHT, CARD_GAP, RUN_ROW = 24, 58, 8, 30
local NEW_ROUTINE_PROMPT = "Create a routine that "
local RUN_TINTS = {
    running = ACCENT,
    done = COLORS.success,
    error = COLORS.danger,
    interrupted = COLORS.danger,
    cancelled = COLORS.muted,
}
local page, scroll, content, notice, empty, runsCaption, showAll, runsEmpty
local cards, runRows = {}, {}
local filter

local function ago(milliseconds)
    if not milliseconds or not time then
        return nil
    end
    local seconds = math.max(0, time() - math.floor(milliseconds / 1000))
    if seconds < 60 then
        return "just now"
    elseif seconds < 3600 then
        return math.floor(seconds / 60) .. "m ago"
    elseif seconds < 86400 then
        return math.floor(seconds / 3600) .. "h ago"
    end
    return math.floor(seconds / 86400) .. "d ago"
end

local function stamp(milliseconds)
    if not milliseconds or not date or not time then
        return ""
    end
    local seconds = math.floor(milliseconds / 1000)
    return time() - seconds < 86400 and date("%H:%M", seconds) or date("%d/%m", seconds)
end

local function routineTitle(id)
    for _, routine in ipairs(ns.routines or {}) do
        if routine.id == id then
            return routine.title
        end
    end
end

local function lastRun(id)
    local latest
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.routineId == id and (not latest or run.startedAt > latest.startedAt) then
            latest = run
        end
    end
    return latest
end

local function setRoutineEnabled(routine, enabled)
    ns.Transport.Send({
        type = "routine_action",
        data = { operation = enabled and "resume" or "pause", id = routine.id },
        context = ns.Character.Capture({ "character" }),
    })
end

local function makeCard()
    local card = CreateFrame("Button", nil, content, "BackdropTemplate")
    card:SetHeight(CARD_HEIGHT)
    box(card, COLORS.raised, COLORS.line)
    local hover = card:CreateTexture(nil, "HIGHLIGHT")
    hover:SetPoint("TOPLEFT", 1, -1)
    hover:SetPoint("BOTTOMRIGHT", -1, 1)
    hover:SetColorTexture(1, 1, 1, 0.03)
    card.title = label(card, "", TEXT, FONTS.strong)
    card.title:SetPoint("TOPLEFT", 14, -12)
    card.title:SetPoint("RIGHT", -60, 0)
    card.title:SetWordWrap(false)
    card.detail = label(card, "", MUTED, FONTS.small)
    card.detail:SetPoint("TOPLEFT", 14, -33)
    card.detail:SetPoint("RIGHT", -60, 0)
    card.detail:SetWordWrap(false)
    card.toggle = widgets.Toggle(card)
    card.toggle:SetPoint("RIGHT", -14, 0)
    card.toggle:SetScript("OnClick", function(self)
        setRoutineEnabled(card.routine, self:GetChecked() == true)
    end)
    card:SetScript("OnClick", function(self)
        filter = filter ~= self.routine.id and self.routine.id or nil
        ns.UI.Routines.Refresh()
    end)
    return card
end

local function makeRunRow()
    local row = widgets.NavItem(content, "", RUN_ROW)
    row.bar:SetColorTexture(0, 0, 0, 0)
    row.mark = widgets.Dot(row, 6)
    row.mark:SetPoint("LEFT", 10, 0)
    row.label:ClearAllPoints()
    row.label:SetPoint("LEFT", 26, 0)
    row.label:SetPoint("RIGHT", -70, 0)
    row.label:SetTextColor(unpack(TEXT))
    row.time = label(row, "", MUTED, FONTS.small)
    row.time:SetPoint("RIGHT", -10, 0)
    row.time:SetJustifyH("RIGHT")
    row:SetScript("OnClick", function(self)
        ns.Chat.Select(self.chatId)
    end)
    return row
end

local function runDescription(run)
    local title = (run.title and run.title ~= "" and run.title)
        or routineTitle(run.routineId)
        or "Routine"
    local status = run.status == "running" and "running"
        or (run.status == "error" and "failed")
        or (run.status ~= "done" and run.status)
    local event = (run.event or ""):gsub("_", " ")
    return title .. " · " .. event .. (status and (" · " .. status) or "")
end

function ns.UI.Routines.Refresh()
    if not page or not page:IsShown() then
        return
    end
    local width = math.max(220, scroll:GetWidth())
    content:SetWidth(width)
    local routines = ns.routines or {}
    if filter and not routineTitle(filter) then
        filter = nil
    end
    notice:SetShown(ns.routinesEnabled == false)
    local y = notice:IsShown() and 26 or 0
    for index, routine in ipairs(routines) do
        local card = cards[index] or makeCard()
        cards[index] = card
        card.routine = routine
        card:SetWidth(width)
        card:ClearAllPoints()
        card:SetPoint("TOPLEFT", 0, -y)
        setText(card.title, routine.title)
        local latest = lastRun(routine.id)
        local when = ago(routine.lastStartedAt or (latest and latest.startedAt))
        local detail = routine.trigger or "Runs on game events"
        if not routine.enabled then
            detail = detail .. " · paused"
        elseif when then
            detail = detail .. " · last run " .. when
        end
        setText(card.detail, detail)
        card.toggle:SetChecked(routine.enabled == true)
        card:SetBackdropBorderColor(
            unpack(filter == routine.id and COLORS.accentLine or COLORS.line)
        )
        card:SetAlpha(routine.enabled and 1 or 0.7)
        card:Show()
        y = y + CARD_HEIGHT + CARD_GAP
    end
    for index = #routines + 1, #cards do
        cards[index]:Hide()
    end
    empty:SetShown(#routines == 0)
    if #routines == 0 then
        empty:ClearAllPoints()
        empty:SetPoint("TOPLEFT", 0, -y)
        empty:SetWidth(width)
        y = y + empty:GetHeight() + CARD_GAP
    end
    y = y + 14
    runsCaption:ClearAllPoints()
    runsCaption:SetPoint("TOPLEFT", 0, -y)
    setText(runsCaption, filter and ("Runs · " .. (routineTitle(filter) or "")) or "Recent runs")
    showAll:SetShown(filter ~= nil)
    showAll:ClearAllPoints()
    showAll:SetPoint("RIGHT", content, "RIGHT", 0, 0)
    showAll:SetPoint("TOP", runsCaption, "TOP", 0, 6)
    y = y + 20
    local runs = {}
    for index = #(ns.routineRuns or {}), 1, -1 do
        local run = ns.routineRuns[index]
        if run.status ~= "no_tip" and (not filter or run.routineId == filter) then
            runs[#runs + 1] = run
        end
    end
    table.sort(runs, function(a, b)
        return (a.startedAt or 0) > (b.startedAt or 0)
    end)
    for index, run in ipairs(runs) do
        local row = runRows[index] or makeRunRow()
        runRows[index] = row
        row.chatId = run.id
        row:SetWidth(width)
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", 0, -y)
        widgets.SetSelected(row, run.id == ns.active)
        row.label:SetTextColor(unpack(TEXT))
        setText(row.label, runDescription(run))
        setText(row.time, stamp(run.startedAt))
        row.mark:SetColorTexture(unpack(RUN_TINTS[run.status] or COLORS.muted))
        row:Show()
        y = y + RUN_ROW
    end
    for index = #runs + 1, #runRows do
        runRows[index]:Hide()
    end
    runsEmpty:SetShown(#runs == 0)
    runsEmpty:ClearAllPoints()
    runsEmpty:SetPoint("TOPLEFT", 0, -y - 4)
    runsEmpty:SetWidth(width)
    if #runs == 0 then
        y = y + runsEmpty:GetStringHeight() + 8
    end
    content:SetHeight(math.max(1, y + 8))
end

--- True while the Routines page covers the conversation panel.
function ns.UI.Routines.IsShown()
    return page ~= nil and page:IsShown()
end

function ns.UI.Routines.Show()
    ns.UI.ShowSettings(nil)
    ns.sidebarTab, ns.routinesPage = "routines", true
    ns.UI.Refresh()
end

function ns.UI.Routines.Hide()
    ns.routinesPage = false
    if ns.sidebarTab == "routines" then
        local chat = ns.Chat.Current()
        ns.sidebarTab = chat and chat.routineId and "routines" or "chats"
    end
    ns.UI.Refresh()
end

-- Called from the window refresh. The way back from a run's conversation is the
-- "Routines" step of the header breadcrumb.
function ns.UI.Routines.Layout()
    if not page then
        return
    end
    -- The page hangs off the window, not the body, so it hides itself while minimized.
    page:SetShown(ns.routinesPage == true and ns.sidebarTab == "routines" and not ns.db.minimized)
    ns.UI.Routines.Refresh()
end

function ns.UI.Routines.Build(frame, panel)
    page = CreateFrame("Frame", "WispAIRoutinesPage", frame, "BackdropTemplate")
    page:SetAllPoints(panel)
    page:SetFrameLevel(frame:GetFrameLevel() + 10)
    box(page, COLORS.window, COLORS.window)
    page:EnableMouse(true)
    page:Hide()
    local title = label(page, "Routines", TEXT, FONTS.heading)
    title:SetPoint("TOPLEFT", PAGE_INSET, -20)
    local subtitle =
        label(page, "Wisp acts on its own when something happens in game.", MUTED, FONTS.small)
    subtitle:SetPoint("TOPLEFT", PAGE_INSET, -48)
    subtitle:SetPoint("RIGHT", -150, 0)
    subtitle:SetWordWrap(true)
    local create = button(page, "+ New routine", 112, function()
        ns.routinesPage = false
        ns.Chat.NewChat()
        if ns.draft then
            ns.draft:SetText(NEW_ROUTINE_PROMPT)
            ns.draft:SetFocus()
        end
    end, "primary")
    create:SetPoint("TOPRIGHT", -PAGE_INSET, -18)
    scroll, content = widgets.ScrollArea(page)
    scroll:SetPoint("TOPLEFT", PAGE_INSET, -80)
    scroll:SetPoint("BOTTOMRIGHT", -PAGE_INSET, 16)
    scroll:SetScript("OnSizeChanged", ns.UI.Routines.Refresh)
    notice = label(
        content,
        "Routines are paused because routine tools are off in Integrations.",
        COLORS.warning,
        FONTS.small
    )
    notice:SetPoint("TOPLEFT", 0, 0)
    notice:SetPoint("RIGHT", 0, 0)
    notice:SetWordWrap(true)
    empty = CreateFrame("Frame", nil, content, "BackdropTemplate")
    empty:SetHeight(CARD_HEIGHT + 8)
    box(empty, COLORS.window, COLORS.line)
    local emptyTitle = label(empty, "No routines yet", TEXT, FONTS.strong)
    emptyTitle:SetPoint("TOPLEFT", 14, -14)
    local emptyDetail = label(
        empty,
        "Ask Wisp to watch for level ups, full bags or new zones, and it will check in on its own.",
        MUTED,
        FONTS.small
    )
    emptyDetail:SetPoint("TOPLEFT", 14, -34)
    emptyDetail:SetPoint("RIGHT", -14, 0)
    emptyDetail:SetWordWrap(true)
    runsCaption = widgets.Caption(content, "Recent runs")
    showAll = button(content, "Show all", 70, function()
        filter = nil
        ns.UI.Routines.Refresh()
    end, "ghost")
    showAll:SetHeight(20)
    runsEmpty = label(
        content,
        "No runs yet. Wisp posts here when a routine has something to say.",
        MUTED,
        FONTS.small
    )
    runsEmpty:SetWordWrap(true)
    page:SetScript("OnShow", ns.UI.Routines.Refresh)
end
