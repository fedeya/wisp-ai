local _, ns = ...
local cards = {}
local container, visibleCount = nil, 0
local questKnown, hasQuests = false, false

-- Layout uses only cached eligibility and current font metrics, never game reads.
function ns.UI.TaskStarters.Layout()
    if not container then
        return
    end
    local width = math.max(1, container:GetWidth() - 16)
    local height = math.max(0, container:GetHeight() - 16)
    local title, detail = container.title, container.detail
    title:ClearAllPoints()
    -- Clear the previous display height before measuring newly wrapped copy.
    title:SetHeight(0)
    title:SetWidth(width)
    local titleHeight = title:GetStringHeight()
    title:SetHeight(titleHeight)
    detail:ClearAllPoints()
    detail:SetHeight(0)
    detail:SetWidth(width)
    local detailHeight = detail:GetStringHeight()
    detail:SetHeight(detailHeight)
    local used = titleHeight + (container.loading and 28 or 0)
    local cardWidth = math.min(220, width)
    for _, card in ipairs(cards) do
        card:SetWidth(cardWidth)
        local font = card:GetFontString()
        if font then
            font:SetWidth(math.max(1, cardWidth - 16))
            font:SetWordWrap(true)
        end
        card:SetHeight(math.max(24, font and font:GetStringHeight() + 8 or 24))
    end
    local firstHeight = visibleCount > 0 and (6 + cards[1]:GetHeight()) or 0
    local showDetail = used + 6 + detailHeight + firstHeight <= height
    if showDetail then
        used = used + 6 + detailHeight
    end
    detail:SetShown(showDetail)
    local count = 0
    for index = 1, visibleCount do
        local nextHeight = used + 6 + cards[index]:GetHeight()
        if nextHeight > height then
            break
        end
        used, count = nextHeight, index
    end
    local top = (container:GetHeight() - used) / 2 + (container.loading and 28 or 0)
    title:SetPoint("TOP", container, "TOP", 0, -top)
    local previous = title
    if showDetail then
        detail:SetPoint("TOP", previous, "BOTTOM", 0, -6)
        previous = detail
    end
    for index, card in ipairs(cards) do
        card:SetShown(index <= count)
        if index <= count then
            card:ClearAllPoints()
            card:SetPoint("TOP", previous, "BOTTOM", 0, -6)
            previous = card
        end
    end
end

local function available(id)
    for _, entry in ipairs(ns.capabilities or {}) do
        if entry.id == id then
            return entry.enabled == true
                and entry.effective ~= false
                and entry.available == true
                and not (ns.capabilityPending or {})[id]
                and (not entry.parent or available(entry.parent))
        end
    end
    return false
end

-- WISP-038: fixed, local invitations; never computed recommendations or tool calls.
local tasks = {
    {
        id = "trainer",
        label = "Review trainer offers",
        capability = "tool:inspect_trainer",
        eligible = function()
            return ns.Character.IsTrainerOpen
                and ns.Character.IsTrainerOpen()
                and type(GetNumTrainerServices) == "function"
                and type(GetTrainerServiceInfo) == "function"
        end,
        prompt = "Inspect the trainer window I have open now. What should I consider learning with my current money? If it is closed, ask me to reopen it. Do not train anything.",
    },
    {
        id = "quests",
        label = "Prioritize my quests",
        capability = "tool:query_character",
        eligible = function()
            if not questKnown then
                questKnown = true
                local ok, active = pcall(function()
                    return ns.Character.HasActiveQuests()
                end)
                hasQuests = ok and active == true
            end
            return hasQuests
        end,
        prompt = "Read my active quests and help me choose what to work on next. Explain any missing information rather than assuming it.",
    },
    {
        id = "tracker",
        label = "Plan a material tracker",
        capability = "tool:manage_panel",
        eligible = function()
            return true
        end,
        prompt = "Help me set up a material tracker. Ask which material and target amount I want before creating it.",
    },
}

local function ready(chat)
    return ns.connected
        and chat
        and chat.id == ns.active
        and chat.status == "idle"
        and chat.messages
        and #chat.messages == 0
        and not chat.routineId
        and not chat.inline
        and not chat.proactive
end

function ns.UI.TaskStarters.Select(id, chatId)
    local chat = ns.Chat.Current()
    if
        not ready(chat)
        or chat.id ~= chatId
        or not ns.draft
        or ns.draft:GetText() ~= ""
        or (ns.db.drafts[chatId] or "") ~= ""
    then
        return false
    end
    for _, task in ipairs(tasks) do
        if task.id == id and available(task.capability) and task.eligible() then
            ns.db.drafts[chatId] = task.prompt
            ns.draft:SetText(task.prompt)
            ns.draft:SetFocus()
            ns.UI.TaskStarters.Refresh(chat)
            return true
        end
    end
    return false
end

function ns.UI.TaskStarters.Refresh(chat)
    local count = 0
    for _, task in ipairs(tasks) do
        if
            ready(chat)
            and ns.draft
            and ns.draft:GetText() == ""
            and (ns.db.drafts[chat.id] or "") == ""
            and available(task.capability)
            and task.eligible()
        then
            count = count + 1
            local card = cards[count]
            if card then
                card.taskId, card.chatId = task.id, chat.id
                ns.UI.Widgets.SetText(card, task.label)
                card:Show()
            end
        end
    end
    for index = count + 1, #cards do
        cards[index]:Hide()
    end
    visibleCount = count
    ns.UI.TaskStarters.Layout()
end

function ns.UI.TaskStarters.Build(parent)
    container = parent
    for index = 1, 3 do
        local card = ns.UI.Widgets.Button(parent, "", 220, function(self)
            ns.UI.TaskStarters.Select(self.taskId, self.chatId)
        end)
        card:Hide()
        cards[index] = card
    end
    parent:SetScript("OnSizeChanged", ns.UI.TaskStarters.Layout)
    local events = CreateFrame("Frame")
    for _, event in ipairs({
        "TRAINER_SHOW",
        "TRAINER_CLOSED",
        "QUEST_LOG_UPDATE",
        "PLAYER_ENTERING_WORLD",
    }) do
        events:RegisterEvent(event)
    end
    events:SetScript("OnEvent", function(_, event)
        if event == "QUEST_LOG_UPDATE" or event == "PLAYER_ENTERING_WORLD" then
            questKnown, hasQuests = false, false
        end
        ns.UI.TaskStarters.Refresh(ns.Chat.Current())
    end)
end
