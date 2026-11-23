local _, ns = ...
local L = ns.L
local label, setText = ns.UI.Widgets.Label, ns.UI.Widgets.SetText
local ACCENT, MUTED = ns.UI.Widgets.ACCENT, ns.UI.Widgets.MUTED
local SETUP_URL = "https://wisp.fedeya.sh/setup?utm_source=wow_addon"
-- Suggestion chips and greetings hold locale keys; text is looked up when shown,
-- in the chat language (`ns.ChatL`), since chips are sent as the player's words.
local SUGGESTION_COUNT = 3
local CHIP_GAP, CHIPS_TOP = 8, 62
local TOOL_ICONS = "Interface\\AddOns\\WispAI\\Textures\\ToolIcons.tga"
-- Loading text shimmer: a soft band of light glides over muted text. The band
-- moves continuously (not a character at a time) and fades with a cosine, and
-- its brightness is quantized so most frames reuse the previous string.
local SHIMMER_HALF = 2.5 -- band half-width, in characters
local SHIMMER_LEVELS = 10
local SHIMMER_PAUSE = 6 -- characters of travel off the end before it returns
local SHIMMER = {}
for level = 1, SHIMMER_LEVELS do
    local t = level / SHIMMER_LEVELS
    local channels = {}
    for index = 1, 3 do
        local from, to = MUTED[index], ns.UI.Widgets.TEXT[index]
        channels[index] = math.floor((from + (to - from) * t) * 255 + 0.5)
    end
    SHIMMER[level] = string.format("|cff%02x%02x%02x", unpack(channels))
end
local header, miniStatus, emptyState, progress
local progressTick = 0

function ns.UI.Activity.SetIcon(texture, cell, tint)
    texture:SetTexture(TOOL_ICONS)
    texture:SetTexCoord(cell / 8, (cell + 1) / 8, 0, 1)
    texture:SetVertexColor(unpack(tint))
end

local function animateText(loader, elapsed)
    loader.elapsed = loader.elapsed + elapsed
    if loader.elapsed < 1 / 30 then
        return
    end
    local text, starts = loader.text, loader.starts
    local count = #starts - 1
    -- About one pass a second for short labels; long ones keep a similar pace.
    loader.cursor = (loader.cursor + loader.elapsed * math.max(12, count / 2.5))
        % (count + SHIMMER_HALF * 2 + SHIMMER_PAUSE)
    loader.elapsed = 0
    local center = loader.cursor - SHIMMER_HALF + 0.5
    local pieces, plainFrom = {}, 1
    for index = math.max(1, math.ceil(center - SHIMMER_HALF)), math.min(count, math.floor(center + SHIMMER_HALF)) do
        local distance = math.abs(index - center)
        local glow = 0.5 + 0.5 * math.cos(math.pi * math.min(1, distance / SHIMMER_HALF))
        local level = math.floor(glow * SHIMMER_LEVELS + 0.5)
        if level > 0 then
            pieces[#pieces + 1] = text:sub(plainFrom, starts[index] - 1)
            pieces[#pieces + 1] = SHIMMER[level]
                .. text:sub(starts[index], starts[index + 1] - 1)
                .. "|r"
            plainFrom = starts[index + 1]
        end
    end
    pieces[#pieces + 1] = text:sub(plainFrom)
    local shown = table.concat(pieces)
    if shown ~= loader.shown then
        loader.shown = shown
        setText(loader.font, shown)
    end
end

-- Labels contain literal text with any pipe characters escaped for WoW.
function ns.UI.Activity.SetLoadingText(row, font, text, active)
    local loader = row.loadingText
    if not active then
        if loader and loader:IsShown() then
            loader:Hide()
            setText(loader.font, loader.text)
        end
        if font then
            setText(font, text)
        end
        return
    end
    if not loader then
        loader = CreateFrame("Frame", nil, row)
        loader:SetScript("OnUpdate", animateText)
        row.loadingText = loader
    end
    if loader.text ~= text or not loader:IsShown() then
        local starts, index = {}, 1
        while index <= #text do
            starts[#starts + 1] = index
            if text:sub(index, index + 1) == "||" then
                index = index + 2
            else
                index = text:find("[^\128-\191]", index + 1) or #text + 1
            end
        end
        starts[#starts + 1] = index
        loader.font, loader.text, loader.starts = font, text, starts
        loader.cursor, loader.elapsed, loader.shown = 0, 0, nil
        setText(font, text)
    end
    loader:Show()
end

-- New chats open with one of these; %s is the character's name.
local GREETINGS = {
    "greeting.whereToNext",
    "greeting.readyForAdventure",
    "greeting.whatsThePlan",
    "greeting.backForMore",
    "greeting.needAHand",
    "greeting.whatAreWeHunting",
    "greeting.findLoot",
    "greeting.questTrouble",
    "greeting.roadAwaits",
    "greeting.hearthstoneReady",
}
local GREETINGS_BY_HOUR = {
    night = { "greeting.stillUp", "greeting.lateNightGrind" },
    morning = { "greeting.goodMorning", "greeting.earlyStart" },
    afternoon = { "greeting.goodAfternoon" },
    evening = { "greeting.goodEvening", "greeting.oneMoreQuest" },
}
local greetingFor = {} -- conversation -> the line it opened with
local suggestionsFor -- conversation the chips were picked for

-- Picks a line once per conversation so it does not change on every refresh.
local function greeting(name, key)
    if not greetingFor[key] then
        local hour = tonumber(date and date("%H") or "") or 12
        local period = hour < 5 and "night"
            or (hour < 12 and "morning" or (hour < 19 and "afternoon" or "evening"))
        local pool = {}
        for _, line in ipairs(GREETINGS) do
            pool[#pool + 1] = line
        end
        for _, line in ipairs(GREETINGS_BY_HOUR[period]) do
            pool[#pool + 1] = line
        end
        greetingFor[key] = pool[math.random(#pool)]
    end
    return ns.ChatL[greetingFor[key]]:format(name)
end

-- "Mage 20 · Elwynn Forest", or nil outside the game.
local function whereabouts()
    local class = UnitClass and UnitClass("player")
    local level = UnitLevel and UnitLevel("player")
    local zone = GetZoneText and GetZoneText()
    local parts = {}
    if class and level then
        parts[#parts + 1] = class .. " " .. level
    end
    if zone and zone ~= "" then
        parts[#parts + 1] = zone
    end
    return #parts > 0 and table.concat(parts, " · ") or nil
end

-- Picks the chips once per conversation, like the greeting, from the player's
-- situation when the chat opens.
local function pickSuggestions(key)
    if suggestionsFor == key then
        return
    end
    suggestionsFor = key
    local keys = ns.UI.Suggestions.Pick(SUGGESTION_COUNT)
    for index, chip in ipairs(emptyState.suggestions) do
        chip.prompt = keys[index]
        chip:SetText(keys[index] and ns.ChatL[keys[index]] or "")
        local font = chip.GetFontString and chip:GetFontString()
        if font then
            ns.UI.Widgets.SetContentText(font, chip:GetText(), ns.UI.Widgets.FONTS.button)
        end
    end
    emptyState.placed = nil -- chip widths changed
end

-- Lays the empty state out around the field when the composer is centered:
-- greeting above, suggestion chips in a row below the model choices. Otherwise
-- it is centered in the transcript with the suggestions stacked.
local function placeEmptyState(centered)
    local field = centered and ns.UI.Composer.Field()
    local width = field and field:GetWidth() or 0
    local key = centered and ("c" .. math.floor(width)) or "t"
    if emptyState.placed == key then
        return
    end
    emptyState.placed = key
    local title, detail = emptyState.title, emptyState.detail
    title:ClearAllPoints()
    detail:ClearAllPoints()
    if centered then
        title:SetPoint("BOTTOM", field, "TOP", 0, 40)
        detail:SetPoint("TOP", title, "BOTTOM", 0, -8)
        detail:SetPoint("LEFT", field, "LEFT", 0, 0)
        detail:SetPoint("RIGHT", field, "RIGHT", 0, 0)
        local total = -CHIP_GAP
        for _, chip in ipairs(emptyState.suggestions) do
            local text = chip.GetFontString and chip:GetFontString()
            chip:SetWidth(math.ceil((text and text:GetStringWidth() or 120) + 26))
            total = total + chip:GetWidth() + CHIP_GAP
        end
        -- One centered row when it fits the field, otherwise one chip per line.
        local x, row = -total / 2, total <= width
        for index, chip in ipairs(emptyState.suggestions) do
            chip:ClearAllPoints()
            if row then
                chip:SetPoint("TOPLEFT", field, "BOTTOM", x, -CHIPS_TOP)
                x = x + chip:GetWidth() + CHIP_GAP
            else
                chip:SetPoint("TOP", field, "BOTTOM", 0, -CHIPS_TOP - (index - 1) * 34)
            end
        end
    else
        title:SetPoint("CENTER", 0, 40)
        detail:SetPoint("TOP", title, "BOTTOM", 0, -10)
        detail:SetPoint("LEFT", 20, 0)
        detail:SetPoint("RIGHT", -20, 0)
        for index, chip in ipairs(emptyState.suggestions) do
            chip:SetWidth(210)
            chip:ClearAllPoints()
            chip:SetPoint("TOP", detail, "BOTTOM", 0, -16 - (index - 1) * 34)
        end
    end
end

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
    local needsSetup = waiting and ns.Transport.needsDesktopSetup == true
    local loading = chat and chat.messages == nil
    emptyState:SetShown(empty and not working)
    if not emptyState:IsShown() and (next(greetingFor) or suggestionsFor) then
        -- The next new chat opens with a fresh line and fresh chips.
        greetingFor, suggestionsFor = {}, nil
    end
    emptyState.loading = not needsSetup and (waiting or loading)
    emptyState.setup:SetShown(needsSetup)
    local ready = empty and not working and not waiting and not loading
    if ready then
        -- Picked once connected, so the conversation count is known.
        pickSuggestions(chat and chat.id or "new")
    end
    local centered = ready and ns.UI.Composer.CanCenter and ns.UI.Composer.CanCenter()
    if ns.UI.Composer.SetCentered then
        ns.UI.Composer.SetCentered(centered)
        placeEmptyState(centered)
    end
    local modelReady = not (ns.modelPending and ns.modelPending[ns.active])
    for _, suggestion in ipairs(emptyState.suggestions) do
        suggestion:SetShown(ready and suggestion.prompt ~= nil)
        suggestion:SetEnabled(modelReady)
    end
    if empty and not working then
        local name = UnitName and UnitName("player") or nil
        local title = name and greeting(name, chat and chat.id or "new") or L["empty.askWisp"]
        local detail = centered and whereabouts() or L["empty.askAbout"]
        if needsSetup then
            title = L["empty.finishSetup"]
            detail = L["empty.setupSteps"]
        elseif waiting then
            title, detail = L["empty.openDesktop"], ""
        elseif loading then
            title, detail = L["empty.loading"], L["empty.fetching"]
        end
        ns.UI.Widgets.SetContentText(emptyState.title, title, ns.UI.Widgets.FONTS.heading)
        ns.UI.Widgets.SetContentText(emptyState.detail, detail, ns.UI.Widgets.FONTS.body)
        for _, dot in ipairs(emptyState.dots) do
            dot:SetShown(emptyState.loading)
        end
    end
    local state, stateElapsed -- what the minimized bar says beside "Wisp AI", and for how long
    if working then
        local now = GetTime()
        ns.workStarted[chat.id] = ns.workStarted[chat.id] or now
        local seconds = math.max(0, math.floor(now - ns.workStarted[chat.id]))
        local elapsed = seconds < 60 and (seconds .. "s")
            or string.format("%dm %02ds", math.floor(seconds / 60), seconds % 60)
        local sending = ns.UI.Activity.IsSending(chat)
        local compacting = chat.usage and chat.usage.compacting
        local phase = compacting and L["activity.compacting"] or L["activity.thinking"]
        setText(progress.elapsed, elapsed)
        local detail = L["activity.preparing"]
        if compacting then
            detail = L["activity.summarizing"]
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
        local titleText = ns.Markdown.InlineRenderer.Literal(activity or phase)
        if titleText ~= progress.titleText then
            ns.UI.Widgets.ChatFont(progress.title, titleText)
        end
        progress.titleText = titleText
        ns.UI.Activity.SetLoadingText(
            progress,
            progress.title,
            progress.titleText,
            progress:IsShown()
        )
        setText(progress.detail, detail)
        state = sending and L["activity.sending"] or phase
        stateElapsed = elapsed
    elseif chat then
        ns.workStarted[chat.id] = nil
    end
    -- Minimized, an unread reply shows a steady accent mark and "New reply";
    -- work in progress shows the pulsing mark and its phase and time.
    local unread = ns.db.minimized and ns.unread == true
    if unread then
        state, stateElapsed = L["activity.newReply"], ""
    elseif not ns.db.minimized then
        state = nil
    end
    miniStatus:SetShown(state ~= nil)
    if state then
        setText(miniStatus.text, state)
        setText(miniStatus.elapsed, stateElapsed or "")
        if miniStatus.unread ~= unread then
            miniStatus.unread = unread
            miniStatus.text:SetTextColor(unpack(unread and ns.UI.Widgets.TEXT or MUTED))
            miniStatus.mark:SetAlpha(1)
        end
    end
end

-- Returns the next transcript offset, including the working assistant row.
-- The row is a single line led by Wisp's pulsing mark; replies carry no author label.
function ns.UI.Activity.LayoutProgress(y, width, _, visible)
    progress:SetShown(visible == true)
    ns.UI.Activity.SetLoadingText(progress, progress.title, progress.titleText, visible == true)
    if not visible then
        return y
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
    if progress:IsShown() then
        progress.mark:SetAlpha(0.35 + 0.65 * (0.5 + 0.5 * math.sin(GetTime() * 3)))
    end
    if miniStatus:IsShown() and not miniStatus.unread then
        miniStatus.mark:SetAlpha(0.35 + 0.65 * (0.5 + 0.5 * math.sin(GetTime() * 3)))
    end
    progressTick = progressTick + elapsed
    if progressTick >= 0.25 then
        progressTick = 0
        ns.UI.Activity.Refresh(ns.Chat.Current())
    end
end

function ns.UI.Activity.Build(windowHeader, transcript, content)
    header = windowHeader
    local chatPanel = transcript:GetParent()
    -- The minimized bar's state line, after the title and clear of the window
    -- button. It takes no mouse input, so the whole bar still drags.
    miniStatus = CreateFrame("Frame", "WispAIMinimizedStatus", header)
    miniStatus:SetHeight(20)
    miniStatus:SetPoint("LEFT", header.title, "RIGHT", 10, 0)
    miniStatus:SetPoint("RIGHT", header.mini, "LEFT", -4, 0)
    miniStatus:EnableMouse(false)
    miniStatus.mark = ns.UI.Widgets.Dot(miniStatus, 6, ACCENT)
    miniStatus.mark:SetPoint("LEFT", 0, 0)
    -- The elapsed time sits at the right edge, so the phase does not shift as it counts.
    miniStatus.elapsed = label(miniStatus, "", MUTED, ns.UI.Widgets.FONTS.small)
    miniStatus.elapsed:SetPoint("RIGHT", -2, 0)
    miniStatus.elapsed:SetJustifyH("RIGHT")
    miniStatus.text = label(miniStatus, "", MUTED, ns.UI.Widgets.FONTS.small)
    miniStatus.text:SetPoint("LEFT", miniStatus.mark, "RIGHT", 6, 0)
    miniStatus.text:SetPoint("RIGHT", miniStatus.elapsed, "LEFT", -6, 0)
    miniStatus.text:SetWordWrap(false)
    miniStatus.unread = false
    miniStatus:Hide()
    emptyState = CreateFrame("Frame", "WispAIChatPlaceholder", chatPanel)
    emptyState:SetAllPoints(transcript)
    emptyState:SetFrameLevel(transcript:GetFrameLevel() + 1)
    emptyState:EnableMouse(false)
    emptyState.title = label(emptyState, "", ns.UI.Widgets.TEXT, ns.UI.Widgets.FONTS.heading)
    emptyState.title:SetPoint("CENTER", 0, 40)
    emptyState.title:SetJustifyH("CENTER")
    emptyState.detail = label(emptyState, "", MUTED)
    emptyState.detail:SetPoint("TOP", emptyState.title, "BOTTOM", 0, -10)
    emptyState.detail:SetPoint("LEFT", 20, 0)
    emptyState.detail:SetPoint("RIGHT", -20, 0)
    emptyState.detail:SetJustifyH("CENTER")
    emptyState.detail:SetWordWrap(true)
    emptyState.setup = ns.UI.Widgets.Button(emptyState, L["empty.setupHelp"], 120, function()
        ns.UI.Widgets.ShowCopyUrl(SETUP_URL)
    end)
    emptyState.setup:SetPoint("TOP", emptyState.detail, "BOTTOM", 0, -12)
    emptyState.setup:Hide()
    emptyState.suggestions = {}
    for index = 1, SUGGESTION_COUNT do
        local suggestion
        suggestion = ns.UI.Widgets.Button(emptyState, "", 210, function()
            if suggestion.prompt then
                ns.Chat.Submit(ns.ChatL[suggestion.prompt])
            end
        end)
        suggestion:SetHeight(28)
        suggestion:Hide()
        emptyState.suggestions[index] = suggestion
    end
    emptyState.starter = emptyState.suggestions[1]
    placeEmptyState(false)
    emptyState.dots = {}
    for index = 1, 3 do
        local dot = label(emptyState, ".", ACCENT)
        dot:SetFontObject("GameFontNormalLarge")
        dot:SetPoint("BOTTOM", emptyState.title, "TOP", (index - 2) * 12, 12)
        emptyState.dots[index] = dot
    end
    progress = CreateFrame("Frame", "WispAIProgress", content)
    progress:SetHeight(23)
    progress.titleText = L["activity.thinking"]
    progress.title = label(progress, progress.titleText, MUTED)
    ns.UI.Widgets.ChatFont(progress.title, progress.titleText)
    progress.title:SetPoint("TOPLEFT", 14, 0)
    progress.title:SetPoint("RIGHT", -65, 0)
    progress.title:SetWordWrap(false)
    -- The mark sits on the title's vertical center whatever the chat font size.
    progress.mark = ns.UI.Widgets.Dot(progress, 6)
    progress.mark:SetPoint("LEFT", progress.title, "LEFT", -13, 0)
    progress.elapsed = label(progress, "", MUTED, ns.UI.Widgets.FONTS.small)
    progress.elapsed:SetPoint("TOPRIGHT", -2, -2)
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
