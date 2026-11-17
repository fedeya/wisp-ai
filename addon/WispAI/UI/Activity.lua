local _, ns = ...
local label, setText = ns.UI.Widgets.Label, ns.UI.Widgets.SetText
local ACCENT, MUTED = ns.UI.Widgets.ACCENT, ns.UI.Widgets.MUTED
local SETUP_URL = "https://wisp.fedeya.sh/setup?utm_source=wow_addon"
local STARTER_PROMPT = "What can you do?"
local SUGGESTIONS = { STARTER_PROMPT, "What should I do next?", "Review my gear" }
local CHIP_GAP, CHIPS_TOP = 8, 62
local TOOL_ICONS = "Interface\\AddOns\\WispAI\\Textures\\ToolIcons.tga"
local WAVE = {
    "|cff9aa7ac",
    "|cffafbbbf",
    "|cffc4ced1",
    "|cffdde4e5",
    "|cfff8fafa",
    "|cffdde4e5",
    "|cffc4ced1",
    "|cffafbbbf",
    "|cff9aa7ac",
}
local header, replyGlow, emptyState, progress
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
    loader.cursor = (loader.cursor + loader.elapsed * math.max(19, count / 1.8))
        % (count + #WAVE + 8)
    loader.elapsed = 0
    local first = math.floor(loader.cursor) - #WAVE + 2
    if first == loader.first then
        return
    end
    loader.first = first
    local left, right = math.max(1, first), math.min(count, first + #WAVE - 1)
    if left > right then
        setText(loader.font, text)
        return
    end
    local pieces = { text:sub(1, starts[left] - 1) }
    for index = left, right do
        pieces[#pieces + 1] = WAVE[index - first + 1]
            .. text:sub(starts[index], starts[index + 1] - 1)
            .. "|r"
    end
    pieces[#pieces + 1] = text:sub(starts[right + 1])
    setText(loader.font, table.concat(pieces))
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
        loader.cursor, loader.elapsed, loader.first = 0, 0, nil
        setText(font, text)
    end
    loader:Show()
end

-- New chats open with one of these; %s is the character's name.
local GREETINGS = {
    "Where to next, %s?",
    "Ready for adventure, %s?",
    "What's the plan, %s?",
    "Back for more, %s?",
    "Need a hand, %s?",
    "What are we hunting today, %s?",
    "Let's find you some loot, %s",
    "Any quest giving you trouble, %s?",
    "The road awaits, %s",
    "Hearthstone ready, %s?",
}
local GREETINGS_BY_HOUR = {
    night = { "Still up, %s? One more dungeon?", "Late night grind, %s?" },
    morning = { "Good morning, %s", "Early start, %s?" },
    afternoon = { "Good afternoon, %s" },
    evening = { "Good evening, %s", "One more quest, %s?" },
}
local greetingFor = {} -- conversation -> the line it opened with

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
    return greetingFor[key]:format(name)
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
    if not emptyState:IsShown() and next(greetingFor) then
        -- The next new chat opens with a fresh line.
        greetingFor = {}
    end
    emptyState.loading = not needsSetup and (waiting or loading)
    emptyState.setup:SetShown(needsSetup)
    local ready = empty and not working and not waiting and not loading
    local centered = ready and ns.UI.Composer.CanCenter and ns.UI.Composer.CanCenter()
    if ns.UI.Composer.SetCentered then
        ns.UI.Composer.SetCentered(centered)
        placeEmptyState(centered)
    end
    local modelReady = not (ns.modelPending and ns.modelPending[ns.active])
    for _, suggestion in ipairs(emptyState.suggestions) do
        suggestion:SetShown(ready)
        suggestion:SetEnabled(modelReady)
    end
    if empty and not working then
        local name = UnitName and UnitName("player") or nil
        local title = name and greeting(name, chat and chat.id or "new") or "Ask Wisp"
        local detail = centered and whereabouts()
            or "Ask about your character, quests, equipment or where to go next."
        if needsSetup then
            title = "Finish Wisp setup"
            detail =
                "Open Wisp Desktop. In Overview, select your WoW folder and choose Install / update addon. Then restart WoW."
        elseif waiting then
            title, detail = "Open Wisp Desktop to connect", ""
        elseif loading then
            title, detail = "Loading conversation", "Fetching your messages."
        end
        setText(emptyState.title, title)
        setText(emptyState.detail, detail)
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
        progress.titleText = ns.Markdown.InlineRenderer.Literal(activity or phase)
        ns.UI.Activity.SetLoadingText(
            progress,
            progress.title,
            progress.titleText,
            progress:IsShown()
        )
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
    replyGlow:SetPoint("TOPLEFT", frame, "TOPLEFT", 0, 0)
    replyGlow:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", 0, 0)
    ns.UI.Widgets.Box(replyGlow, { 0, 0, 0, 0 }, ACCENT)
    replyGlow:EnableMouse(false)
    replyGlow:Hide()
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
    emptyState.setup = ns.UI.Widgets.Button(emptyState, "Setup help", 120, function()
        ns.UI.Widgets.ShowCopyUrl(SETUP_URL)
    end)
    emptyState.setup:SetPoint("TOP", emptyState.detail, "BOTTOM", 0, -12)
    emptyState.setup:Hide()
    emptyState.suggestions = {}
    for index, prompt in ipairs(SUGGESTIONS) do
        local suggestion = ns.UI.Widgets.Button(emptyState, prompt, 210, function()
            ns.Chat.Submit(prompt)
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
    progress.mark = ns.UI.Widgets.Dot(progress, 6)
    progress.mark:SetPoint("TOPLEFT", 1, -5)
    progress.titleText = "Thinking"
    progress.title = label(progress, progress.titleText, MUTED)
    ns.UI.Widgets.ChatFont(progress.title, progress.titleText)
    progress.title:SetPoint("TOPLEFT", 14, 0)
    progress.title:SetPoint("RIGHT", -65, 0)
    progress.title:SetWordWrap(false)
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
