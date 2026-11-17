local _, ns = ...
local L = ns.L
local toast, body
local events, subscribed = nil, {}
local queued = {}
-- Toast layout, in UI units: a card on the window's ground with the Wisp mark
-- and routine as its caption, the tip below, and the actions along the bottom.
local TOAST_WIDTH, PAD, BODY_TOP, BODY_LINES = 320, 14, 40, 5
local ACTIONS_HEIGHT = 14 + 24 + 12 -- gap, button row, bottom margin
local function ready()
    if
        (InCombatLockdown and InCombatLockdown())
        or (UnitAffectingCombat and UnitAffectingCombat("player"))
    then
        return false
    end
    for _, chat in ipairs(ns.chats or {}) do
        if chat.status == "working" then
            return false
        end
    end
    return true
end
local function send(kind, data)
    data.ready = ready()
    ns.Transport.Send({
        type = kind,
        data = data,
        context = ns.Character.Capture({ "character", "location" }),
    })
end
function ns.Advice.ReceiveRoutineSubscriptions(subscriptions, enabled)
    ns.routinesEnabled = enabled
    if not events then
        return
    end
    local nextSubscriptions = {}
    for _, item in ipairs(subscriptions or {}) do
        nextSubscriptions[item.native] = item.event
        if not subscribed[item.native] then
            pcall(events.RegisterEvent, events, item.native)
        end
    end
    for native in pairs(subscribed) do
        if not nextSubscriptions[native] then
            events:UnregisterEvent(native)
        end
    end
    subscribed = nextSubscriptions
end
function ns.Advice.RefreshAdvice()
    if not toast then
        return
    end
    local tip = (ns.notifications or {})[#(ns.notifications or {})]
    if not tip then
        toast:Hide()
        return
    end
    toast.chatId = tip.id
    local routineName
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.id == tip.id then
            for _, routine in ipairs(ns.routines or {}) do
                if routine.id == run.routineId then
                    routineName = routine.title
                end
            end
        end
    end
    toast.heading:SetText(L["routines.routine"] .. (routineName and (" · " .. routineName) or ""))
    local preview = tip.title
    for _, chat in ipairs(ns.chats or {}) do
        if chat.id == tip.id then
            for _, message in ipairs(chat.messages or {}) do
                if message.role == "assistant" and message.text and message.text ~= "" then
                    preview = message.text
                        :gsub("%[%[ref:([%w_-]+)%]%]", function(key)
                            local ref = message.references and message.references[key]
                            return ref and ref.label or L["advice.reference"]
                        end)
                        :gsub("[%*`]", "")
                        :gsub("|", "||")
                        :sub(1, 220)
                    break
                end
            end
        end
    end
    body:SetText(preview)
    -- The card grows with the tip, up to BODY_LINES lines.
    toast:SetHeight(math.floor(BODY_TOP + (body:GetStringHeight() or 0) + ACTIONS_HEIGHT + 0.5))
    toast:Show()
end
local function dismissTip()
    ns.Transport.Send({ type = "dismiss_tip", chat = toast.chatId })
    for i = #(ns.notifications or {}), 1, -1 do
        if ns.notifications[i].id == toast.chatId then
            table.remove(ns.notifications, i)
        end
    end
    ns.Advice.RefreshAdvice()
end
local function buildToast()
    local widgets = ns.UI.Widgets
    local COLORS = widgets.COLORS
    toast = CreateFrame("Frame", "WispAISuggestion", UIParent)
    toast:SetSize(TOAST_WIDTH, 120)
    toast:SetPoint("BOTTOMRIGHT", UIParent, "BOTTOMRIGHT", -40, 190)
    toast:SetFrameStrata("DIALOG")
    toast:SetClampedToScreen(true)
    toast:EnableMouse(true)
    -- The main window's ground and hairline, so the tip reads as part of Wisp.
    widgets.Box(toast, COLORS.window, COLORS.line)
    local mark = toast:CreateTexture(nil, "ARTWORK")
    mark:SetTexture(widgets.TEXTURES .. "Wisp.tga")
    mark:SetSize(16, 16)
    mark:SetPoint("TOPLEFT", PAD, -12)
    local close = CreateFrame("Button", "WispAISuggestionClose", toast)
    close:SetSize(20, 20)
    close:SetPoint("TOPRIGHT", -8, -10)
    close.icon = close:CreateTexture(nil, "ARTWORK")
    close.icon:SetTexture(widgets.TEXTURES .. "Close.tga")
    close.icon:SetSize(10, 10)
    close.icon:SetPoint("CENTER")
    close.icon:SetVertexColor(unpack(COLORS.secondary))
    widgets.Hover(close, 0.08)
    close:SetScript("OnClick", dismissTip)
    close:SetScript("OnEnter", function(self)
        self.icon:SetVertexColor(unpack(COLORS.text))
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(L["advice.dismiss"])
        GameTooltip:Show()
    end)
    close:SetScript("OnLeave", function(self)
        self.icon:SetVertexColor(unpack(COLORS.secondary))
        GameTooltip:Hide()
    end)
    toast.close = close
    toast.heading = widgets.Caption(toast, L["routines.routine"])
    toast.heading:SetPoint("LEFT", mark, "RIGHT", 8, 0)
    toast.heading:SetPoint("RIGHT", close, "LEFT", -6, 0)
    toast.heading:SetWordWrap(false)
    body = widgets.Label(toast, "", COLORS.text, widgets.FONTS.body)
    body:SetPoint("TOPLEFT", PAD, -BODY_TOP)
    body:SetWidth(TOAST_WIDTH - PAD * 2)
    body:SetWordWrap(true)
    body:SetSpacing(2)
    body:SetMaxLines(BODY_LINES)
    toast.body = body
    local read = widgets.Button(toast, L["advice.read"], 72, function()
        local id = toast.chatId
        toast:Hide()
        ns.Chat.Select(id)
        ns.UI.SetMinimized(false)
    end, "primary")
    read:SetPoint("BOTTOMRIGHT", -PAD, 12)
    toast.read = read
    -- A ghost link whose label lines up with the tip's text.
    local all = widgets.Button(toast, L["advice.allRoutines"], 96, function()
        toast:Hide()
        ns.UI.SetMinimized(false)
        ns.UI.Routines.Show()
    end, "ghost")
    all:SetPoint("BOTTOMLEFT", PAD - 6, 12)
    toast.all = all
    toast:Hide()
end
function ns.Advice.InitAdvice()
    events = CreateFrame("Frame")
    events:SetScript("OnEvent", function(_, native, value)
        local event = subscribed[native]
        if not event then
            return
        end
        local values = {}
        if event == "level_up" then
            values.level = tonumber(value)
        elseif event == "equipment_changed" then
            values.slot = tonumber(value)
            values.itemId = (GetInventoryItemID and GetInventoryItemID("player", value)) or 0
        elseif event == "money_changed" then
            values.copper = GetMoney()
        elseif event == "zone_changed" then
            values.zone = GetRealZoneText() or ""
        end
        local key = event
            .. ((event == "equipment_changed" or event == "level_up") and tostring(value) or "")
        queued[key] = { event = event, values = values }
    end)
    -- Debounce noisy native events before crossing the file transport.
    C_Timer.NewTicker(2, function()
        if not ns.connected or not ns.routinesEnabled then
            queued = {}
            return
        end
        local pending = queued
        queued = {}
        for _, item in pairs(pending) do
            send("routine_event", item)
        end
    end)
    C_Timer.NewTicker(15, function()
        if ns.connected and ns.routinesEnabled then
            send("routine_tick", {})
        end
    end)
    buildToast()
end
