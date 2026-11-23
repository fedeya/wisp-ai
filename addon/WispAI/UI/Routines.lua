local _, ns = ...
local L = ns.L
local widgets = ns.UI.Widgets
local COLORS, FONTS = widgets.COLORS, widgets.FONTS
local label, setText, box, button = widgets.Label, widgets.SetText, widgets.Box, widgets.Button
local TEXT, MUTED, ACCENT = widgets.TEXT, widgets.MUTED, widgets.ACCENT
local PAGE_INSET, CARD_HEIGHT, CARD_GAP, RUN_ROW, BACK_BAND = 24, 58, 8, 30, 40
-- These tables hold locale keys; text is looked up when shown.
-- Ready-made routines offered by New routine; each fills the composer to review and send.
local TEMPLATES = {
    {
        title = "routineTemplate.levelUpTitle",
        prompt = "routineTemplate.levelUpPrompt",
    },
    {
        title = "routineTemplate.bagsTitle",
        prompt = "routineTemplate.bagsPrompt",
    },
    {
        title = "routineTemplate.zoneTitle",
        prompt = "routineTemplate.zonePrompt",
    },
    {
        title = "routineTemplate.gearTitle",
        prompt = "routineTemplate.gearPrompt",
    },
}
local EVENT_LABELS = {
    level_up = "routineEvent.levelUp",
    equipment_changed = "routineEvent.gearChanged",
    money_changed = "routineEvent.moneyChanged",
    bags_changed = "routineEvent.bagsChanged",
    quests_changed = "routineEvent.questsUpdated",
    spells_changed = "routineEvent.newSpells",
    talents_changed = "routineEvent.talentsChanged",
    zone_changed = "routineEvent.newZone",
    interval = "routineEvent.scheduled",
    tick = "routineEvent.scheduled",
}
local RUN_TINTS = {
    running = ACCENT,
    done = COLORS.success,
    error = COLORS.danger,
    interrupted = COLORS.danger,
    cancelled = COLORS.muted,
}
local RUN_STATUS = {
    running = "routineRun.running",
    error = "routineRun.failed",
    interrupted = "routineRun.interrupted",
    cancelled = "routineRun.cancelled",
}

-- The page shows one view at a time: the routine list, one routine's detail,
-- or the templates for a new routine.
local page, views = nil, {}
local list, detail, templates = {}, {}, {}
local view, detailId = "list", nil
local pending = {} -- routine id -> enabled, while a pause or resume is on its way

--- A readable name for a routine event ("level_up" -> "Level up").
function ns.UI.Routines.EventLabel(event)
    if not event or event == "" then
        return L["routines.routine"]
    end
    return EVENT_LABELS[event] and L[EVENT_LABELS[event]]
        or (event:gsub("_", " "):gsub("^%l", string.upper))
end
local eventLabel = ns.UI.Routines.EventLabel

local function routineById(id)
    for _, routine in ipairs(ns.routines or {}) do
        if routine.id == id then
            return routine
        end
    end
end

--- The title of the routine with `id`, if it still exists.
function ns.UI.Routines.Title(id)
    local routine = routineById(id)
    return routine and routine.title
end

local function ago(milliseconds)
    if not milliseconds or not time then
        return nil
    end
    local seconds = math.max(0, time() - math.floor(milliseconds / 1000))
    if seconds < 60 then
        return L["time.justNow"]
    elseif seconds < 3600 then
        return L["time.minutesAgo"]:format(math.floor(seconds / 60))
    elseif seconds < 86400 then
        return L["time.hoursAgo"]:format(math.floor(seconds / 3600))
    end
    return L["time.daysAgo"]:format(math.floor(seconds / 86400))
end

local function clock(milliseconds)
    if not milliseconds or not date then
        return ""
    end
    return date("%H:%M", math.floor(milliseconds / 1000))
end

-- Runs that left a tip, newest first; silent checks are not listed.
local function visibleRuns(routineId)
    local runs = {}
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.status ~= "no_tip" and (not routineId or run.routineId == routineId) then
            runs[#runs + 1] = run
        end
    end
    table.sort(runs, function(a, b)
        return (a.startedAt or 0) > (b.startedAt or 0)
    end)
    return runs
end

local function isEnabled(routine)
    if pending[routine.id] ~= nil then
        return pending[routine.id]
    end
    return routine.enabled == true
end

-- What a routine card or detail says under its title: the trigger, then the
-- latest tip, or when it last checked, or that it is paused or saving.
local function summary(routine)
    local text = routine.trigger or L["routines.runsOnEvents"]
    if pending[routine.id] ~= nil then
        return L["routines.summarySaving"]:format(text)
    elseif not isEnabled(routine) then
        return L["routines.summaryPaused"]:format(text)
    end
    local latest = visibleRuns(routine.id)[1]
    local tipped = latest and ago(latest.startedAt)
    if tipped then
        return L["routines.summaryLastTip"]:format(text, tipped)
    end
    local checked = ago(routine.lastStartedAt)
    return checked and L["routines.summaryChecked"]:format(text, checked) or text
end

local function send(operation, id)
    ns.Transport.Send({
        type = "routine_action",
        data = { operation = operation, id = id },
        context = ns.Character.Capture({ "character" }),
    })
end

local function setRoutineEnabled(routine, enabled)
    pending[routine.id] = enabled
    send(enabled and "resume" or "pause", routine.id)
    ns.UI.Routines.Refresh()
end

-- Routines are created and changed by talking to Wisp: open a new chat with
-- the request started for the player to finish.
local function startChat(prompt)
    ns.Chat.StartNew()
    if ns.draft then
        ns.draft:SetText(prompt)
        ns.draft:SetFocus()
    end
end

local function editRoutine(routine)
    startChat(ns.ChatL["routines.promptChange"]:format(routine.title))
end

local function deleteRoutine(routine)
    StaticPopup_Show("WISPAI_DELETE_ROUTINE", routine.title, nil, routine.id)
end

local function routineMenu(owner, routine)
    if not (MenuUtil and MenuUtil.CreateContextMenu) then
        return
    end
    MenuUtil.CreateContextMenu(owner, function(_, root)
        root:CreateButton(L["common.open"], function()
            ns.UI.Routines.ShowRoutine(routine.id)
        end)
        root:CreateButton(
            isEnabled(routine) and L["routines.pause"] or L["routines.resume"],
            function()
                setRoutineEnabled(routine, not isEnabled(routine))
            end
        )
        root:CreateButton(L["routines.editWithWisp"], function()
            editRoutine(routine)
        end)
        root:CreateButton(L["common.delete"], function()
            deleteRoutine(routine)
        end)
    end)
end

-- A view: a frame over the page with a scroll area for its content. Subviews
-- have a back link to the routine list in a band closed by a hairline.
local function makeView(withBack)
    local frame = CreateFrame("Frame", nil, page)
    frame:SetAllPoints(page)
    frame:Hide()
    local top = 0
    if withBack then
        local back = widgets.BackLink(frame, L["routines.title"], function()
            ns.UI.Routines.Show()
        end)
        back:SetPoint("TOPLEFT", PAGE_INSET, -10)
        local rule = frame:CreateTexture(nil, "ARTWORK")
        rule:SetPoint("TOPLEFT", 0, -BACK_BAND)
        rule:SetPoint("TOPRIGHT", 0, -BACK_BAND)
        rule:SetHeight(widgets.OnePixel(rule))
        widgets.Tint(rule, COLORS.line)
        top = BACK_BAND
    end
    local scroll, content = widgets.ScrollArea(frame)
    scroll:SetPoint("TOPLEFT", PAGE_INSET, -top - 18)
    scroll:SetPoint("BOTTOMRIGHT", -PAGE_INSET, 16)
    scroll:SetScript("OnSizeChanged", function()
        ns.UI.Routines.Refresh()
    end)
    return frame, scroll, content
end

-- A clickable card with a title over a one-line detail; `right` is the space
-- kept clear for controls on its right edge.
local function cardButton(parent, right)
    local card = CreateFrame("Button", nil, parent, "BackdropTemplate")
    card:SetHeight(CARD_HEIGHT)
    box(card, COLORS.raised, COLORS.line)
    widgets.Hover(card, 0.04, 1)
    card.title = label(card, "", TEXT, FONTS.strong)
    card.title:SetPoint("TOPLEFT", 14, -12)
    card.title:SetPoint("RIGHT", -right, 0)
    card.title:SetWordWrap(false)
    card.detail = label(card, "", MUTED, FONTS.small)
    card.detail:SetPoint("TOPLEFT", 14, -33)
    card.detail:SetPoint("RIGHT", -right, 0)
    card.detail:SetWordWrap(false)
    return card
end

local function makeCard(parent)
    local card = cardButton(parent, 76)
    card.chevron = card:CreateTexture(nil, "ARTWORK")
    card.chevron:SetTexture(widgets.TEXTURES .. "Back.tga")
    card.chevron:SetTexCoord(1, 0, 0, 1)
    card.chevron:SetSize(10, 10)
    card.chevron:SetPoint("RIGHT", -12, 0)
    card.chevron:SetVertexColor(unpack(COLORS.muted))
    card.toggle = widgets.Toggle(card)
    card.toggle:SetPoint("RIGHT", card.chevron, "LEFT", -12, 0)
    card.toggle:SetScript("OnClick", function(self)
        setRoutineEnabled(card.routine, self:GetChecked() == true)
    end)
    card:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    card:SetScript("OnClick", function(self, mouse)
        if mouse == "RightButton" then
            routineMenu(self, self.routine)
        else
            ns.UI.Routines.ShowRoutine(self.routine.id)
        end
    end)
    return card
end

local function makeRunRow(parent)
    local row = widgets.NavItem(parent, "", RUN_ROW)
    row.mark = widgets.Dot(row, 6)
    row.mark:SetPoint("LEFT", 10, 0)
    row.label:ClearAllPoints()
    row.label:SetPoint("LEFT", 26, 0)
    row.label:SetPoint("RIGHT", -60, 0)
    row.label:SetTextColor(unpack(TEXT))
    row.time = label(row, "", MUTED, FONTS.small)
    row.time:SetPoint("RIGHT", -10, 0)
    row.time:SetJustifyH("RIGHT")
    row:SetScript("OnClick", function(self)
        ns.Chat.Select(self.chatId)
    end)
    return row
end

-- Lays runs out under day headings from `y`; returns the next offset.
-- `named` puts each run's routine before its event (the list shows all routines).
local function layoutRuns(parent, pools, runs, y, width, named)
    local rowCount, headerCount, lastDay = 0, 0, nil
    for _, run in ipairs(runs) do
        local day = widgets.DayLabel(run.startedAt)
        if day ~= lastDay then
            lastDay = day
            headerCount = headerCount + 1
            local header = pools.headers[headerCount] or widgets.Caption(parent, "")
            pools.headers[headerCount] = header
            header:ClearAllPoints()
            header:SetPoint("TOPLEFT", 0, -y - (headerCount > 1 and 10 or 0))
            setText(header, day)
            header:Show()
            y = y + (headerCount > 1 and 30 or 20)
        end
        rowCount = rowCount + 1
        local row = pools.rows[rowCount] or makeRunRow(parent)
        pools.rows[rowCount] = row
        row.chatId = run.id
        row:SetWidth(width)
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", 0, -y)
        widgets.SetSelected(row, run.id == ns.active)
        row.label:SetTextColor(unpack(TEXT))
        local text = eventLabel(run.event)
        if named then
            text = (ns.UI.Routines.Title(run.routineId) or run.title or L["routines.routine"])
                .. " · "
                .. text
        end
        local status = RUN_STATUS[run.status] and L[RUN_STATUS[run.status]]
        setText(row.label, status and (text .. " · " .. status) or text)
        setText(row.time, clock(run.startedAt))
        row.mark:SetColorTexture(unpack(RUN_TINTS[run.status] or COLORS.muted))
        row:Show()
        y = y + RUN_ROW
    end
    for index = rowCount + 1, #pools.rows do
        pools.rows[index]:Hide()
    end
    for index = headerCount + 1, #pools.headers do
        pools.headers[index]:Hide()
    end
    return y
end

local function refreshList()
    local width = math.max(220, list.scroll:GetWidth())
    local content = list.content
    content:SetWidth(width)
    local routines = ns.routines or {}
    list.notice:SetShown(ns.routinesEnabled == false)
    local y = list.notice:IsShown() and 26 or 0
    for index, routine in ipairs(routines) do
        local card = list.cards[index] or makeCard(content)
        list.cards[index] = card
        card.routine = routine
        card:SetWidth(width)
        card:ClearAllPoints()
        card:SetPoint("TOPLEFT", 0, -y)
        widgets.SetContentText(card.title, routine.title, FONTS.strong)
        setText(card.detail, summary(routine))
        card.toggle:SetChecked(isEnabled(routine))
        card:SetAlpha(isEnabled(routine) and 1 or 0.7)
        card:Show()
        y = y + CARD_HEIGHT + CARD_GAP
    end
    for index = #routines + 1, #list.cards do
        list.cards[index]:Hide()
    end
    list.empty:SetShown(#routines == 0)
    if #routines == 0 then
        list.empty:ClearAllPoints()
        list.empty:SetPoint("TOPLEFT", 0, -y)
        list.empty:SetWidth(width)
        y = y + list.empty:GetHeight() + CARD_GAP
    end
    y = y + 14
    list.runsCaption:ClearAllPoints()
    list.runsCaption:SetPoint("TOPLEFT", 0, -y)
    y = y + 22
    local runs = visibleRuns()
    y = layoutRuns(content, list, runs, y, width, true)
    list.runsEmpty:SetShown(#runs == 0)
    list.runsEmpty:ClearAllPoints()
    list.runsEmpty:SetPoint("TOPLEFT", 0, -y - 4)
    list.runsEmpty:SetWidth(width)
    if #runs == 0 then
        y = y + list.runsEmpty:GetStringHeight() + 8
    end
    content:SetHeight(math.max(1, y + 8))
end

local function refreshDetail()
    local routine = routineById(detailId)
    if not routine then
        -- The routine was removed; go back to the list.
        view, detailId = "list", nil
        return false
    end
    local width = math.max(220, detail.scroll:GetWidth())
    local content = detail.content
    content:SetWidth(width)
    widgets.SetContentText(detail.title, routine.title, FONTS.heading)
    setText(detail.summary, summary(routine))
    detail.toggle:SetChecked(isEnabled(routine))
    setText(detail.state, isEnabled(routine) and L["routines.active"] or L["routines.paused"])
    local instruction = routine.instruction
    setText(
        detail.instruction,
        instruction and instruction ~= "" and instruction or L["routines.noInstruction"]
    )
    local y = 130 + detail.instruction:GetStringHeight() + 24
    detail.historyCaption:ClearAllPoints()
    detail.historyCaption:SetPoint("TOPLEFT", 0, -y)
    y = y + 22
    local runs = visibleRuns(routine.id)
    y = layoutRuns(content, detail, runs, y, width, false)
    detail.runsEmpty:SetShown(#runs == 0)
    detail.runsEmpty:ClearAllPoints()
    detail.runsEmpty:SetPoint("TOPLEFT", 0, -y - 4)
    detail.runsEmpty:SetWidth(width)
    if #runs == 0 then
        y = y + detail.runsEmpty:GetStringHeight() + 8
    end
    content:SetHeight(math.max(1, y + 8))
    return true
end

local function refreshTemplates()
    local width = math.max(220, templates.scroll:GetWidth())
    templates.content:SetWidth(width)
    for _, card in ipairs(templates.cards) do
        card:SetWidth(width)
    end
end

function ns.UI.Routines.Refresh()
    if not page or not page:IsShown() then
        return
    end
    -- A pause or resume is settled once the bridge reports the new state.
    for id, enabled in pairs(pending) do
        local routine = routineById(id)
        if not routine or routine.enabled == enabled then
            pending[id] = nil
        end
    end
    if view == "routine" and not refreshDetail() then
        view = "list"
    end
    if view == "list" then
        refreshList()
    elseif view == "new" then
        refreshTemplates()
    end
    for name, frame in pairs(views) do
        frame:SetShown(name == view)
    end
end

--- True while the Routines page covers the conversation panel.
function ns.UI.Routines.IsShown()
    return page ~= nil and page:IsShown()
end

local function open(nextView, id)
    ns.UI.ShowSettings(nil)
    view, detailId = nextView, id
    ns.sidebarTab, ns.routinesPage = "routines", true
    ns.UI.Refresh()
end

--- Opens the routine list.
function ns.UI.Routines.Show()
    open("list")
end

--- Opens one routine's page: what it does, its controls and its runs.
function ns.UI.Routines.ShowRoutine(id)
    open("routine", id)
end

--- Opens the templates for a new routine.
function ns.UI.Routines.ShowTemplates()
    open("new")
end

--- Steps back: a routine or the templates to the list, the list to the chat.
function ns.UI.Routines.Back()
    if view ~= "list" then
        ns.UI.Routines.Show()
    else
        ns.UI.Routines.Hide()
    end
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

local function buildList()
    local frame, scroll, content = makeView(false)
    views.list = frame
    list.scroll, list.content, list.cards = scroll, content, {}
    list.rows, list.headers = {}, {}
    local title = label(frame, L["routines.title"], TEXT, FONTS.heading)
    title:SetPoint("TOPLEFT", PAGE_INSET, -20)
    local subtitle = label(frame, L["routines.subtitle"], MUTED, FONTS.small)
    subtitle:SetPoint("TOPLEFT", PAGE_INSET, -48)
    subtitle:SetPoint("RIGHT", -150, 0)
    subtitle:SetWordWrap(true)
    local create = button(frame, L["routines.newButton"], 112, function()
        ns.UI.Routines.ShowTemplates()
    end, "primary")
    create:SetPoint("TOPRIGHT", -PAGE_INSET, -18)
    scroll:SetPoint("TOPLEFT", PAGE_INSET, -80)
    list.notice = label(content, L["routines.pausedNotice"], COLORS.warning, FONTS.small)
    list.notice:SetPoint("TOPLEFT", 0, 0)
    list.notice:SetPoint("RIGHT", 0, 0)
    list.notice:SetWordWrap(true)
    list.empty = CreateFrame("Frame", nil, content, "BackdropTemplate")
    list.empty:SetHeight(CARD_HEIGHT + 8)
    box(list.empty, COLORS.window, COLORS.line)
    local emptyTitle = label(list.empty, L["routines.emptyTitle"], TEXT, FONTS.strong)
    emptyTitle:SetPoint("TOPLEFT", 14, -14)
    local emptyDetail = label(list.empty, L["routines.emptyDetail"], MUTED, FONTS.small)
    emptyDetail:SetPoint("TOPLEFT", 14, -34)
    emptyDetail:SetPoint("RIGHT", -14, 0)
    emptyDetail:SetWordWrap(true)
    list.runsCaption = widgets.Caption(content, L["routines.recentRuns"])
    list.runsEmpty = label(content, L["routines.noRuns"], MUTED, FONTS.small)
    list.runsEmpty:SetWordWrap(true)
end

local function buildDetail()
    local frame, scroll, content = makeView(true)
    views.routine = frame
    detail.scroll, detail.content = scroll, content
    detail.rows, detail.headers = {}, {}
    detail.title = label(content, "", TEXT, FONTS.heading)
    detail.title:SetPoint("TOPLEFT", 0, 0)
    detail.title:SetPoint("RIGHT", 0, 0)
    detail.title:SetWordWrap(false)
    detail.summary = label(content, "", MUTED, FONTS.small)
    detail.summary:SetPoint("TOPLEFT", 0, -28)
    detail.summary:SetPoint("RIGHT", 0, 0)
    detail.summary:SetWordWrap(true)
    detail.toggle = widgets.Toggle(content)
    detail.toggle:SetPoint("TOPLEFT", 0, -62)
    detail.toggle:SetScript("OnClick", function(self)
        local routine = routineById(detailId)
        if routine then
            setRoutineEnabled(routine, self:GetChecked() == true)
        end
    end)
    detail.state = label(content, "", TEXT)
    detail.state:SetPoint("LEFT", detail.toggle, "RIGHT", 8, 0)
    local delete = button(content, L["common.delete"], 70, function()
        local routine = routineById(detailId)
        if routine then
            deleteRoutine(routine)
        end
    end, "ghost")
    delete:SetPoint("TOPRIGHT", 0, -58)
    local deleteText = delete.GetFontString and delete:GetFontString()
    if deleteText then
        deleteText:SetTextColor(unpack(COLORS.danger))
    end
    local edit = button(content, L["routines.editWithWisp"], 112, function()
        local routine = routineById(detailId)
        if routine then
            editRoutine(routine)
        end
    end)
    edit:SetPoint("RIGHT", delete, "LEFT", -8, 0)
    local about = widgets.Caption(content, L["routines.whatItDoes"])
    about:SetPoint("TOPLEFT", 0, -110)
    detail.instruction = label(content, "", widgets.TEXT)
    detail.instruction:SetPoint("TOPLEFT", 0, -130)
    detail.instruction:SetPoint("RIGHT", 0, 0)
    detail.instruction:SetWordWrap(true)
    detail.instruction:SetSpacing(3)
    detail.historyCaption = widgets.Caption(content, L["routines.history"])
    detail.runsEmpty = label(content, L["routines.noTips"], MUTED, FONTS.small)
    detail.runsEmpty:SetWordWrap(true)
end

local function buildTemplates()
    local frame, scroll, content = makeView(true)
    views.new = frame
    templates.scroll, templates.content = scroll, content
    templates.cards = {}
    local heading = label(content, L["routines.newTitle"], TEXT, FONTS.heading)
    heading:SetPoint("TOPLEFT", 0, 0)
    local intro = label(content, L["routines.newIntro"], MUTED, FONTS.small)
    intro:SetPoint("TOPLEFT", 0, -28)
    intro:SetPoint("RIGHT", 0, 0)
    intro:SetWordWrap(true)
    local y = 64
    for index, template in ipairs(TEMPLATES) do
        local card = cardButton(content, 14)
        card:SetPoint("TOPLEFT", 0, -y)
        setText(card.title, L[template.title])
        -- The request is the player's words to Wisp, so it is in the chat language.
        widgets.SetContentText(card.detail, ns.ChatL[template.prompt], FONTS.small)
        card:SetScript("OnClick", function()
            startChat(ns.ChatL["routines.promptCreate"]:format(ns.ChatL[template.prompt]))
        end)
        templates.cards[index] = card
        y = y + CARD_HEIGHT + CARD_GAP
    end
    local own = button(content, L["routines.writeYourOwn"], 120, function()
        startChat(ns.ChatL["routines.promptWriteOwn"])
    end)
    own:SetPoint("TOPLEFT", 0, -y - 8)
    content:SetHeight(y + 48)
end

function ns.UI.Routines.Build(frame, panel)
    StaticPopupDialogs.WISPAI_DELETE_ROUTINE = {
        text = L["routines.deleteConfirm"],
        button1 = L["common.delete"],
        button2 = L["common.cancel"],
        OnAccept = function(_, id)
            send("remove", id)
            ns.UI.Routines.Show()
        end,
        timeout = 0,
        whileDead = true,
        hideOnEscape = true,
    }
    page = CreateFrame("Frame", "WispAIRoutinesPage", frame, "BackdropTemplate")
    page:SetAllPoints(panel)
    page:SetFrameLevel(frame:GetFrameLevel() + 10)
    box(page, COLORS.window, COLORS.window)
    page:EnableMouse(true)
    page:Hide()
    buildList()
    buildDetail()
    buildTemplates()
    page:SetScript("OnShow", ns.UI.Routines.Refresh)
end
