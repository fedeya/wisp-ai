local _, ns = ...
local toast, body
local events, subscribed = nil, {}
local queued = {}
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
    toast.heading:SetText("Routine" .. (routineName and (" · " .. routineName) or ""))
    local preview = tip.title
    for _, chat in ipairs(ns.chats or {}) do
        if chat.id == tip.id then
            for _, message in ipairs(chat.messages or {}) do
                if message.role == "assistant" and message.text and message.text ~= "" then
                    preview = message.text
                        :gsub("%[%[ref:([%w_-]+)%]%]", function(key)
                            local ref = message.references and message.references[key]
                            return ref and ref.label or "Reference"
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
    toast:Show()
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
    toast = CreateFrame("Frame", "WispAISuggestion", UIParent, "BackdropTemplate")
    toast:SetSize(350, 150)
    toast:SetPoint("BOTTOMRIGHT", UIParent, "BOTTOMRIGHT", -40, 190)
    toast:SetFrameStrata("DIALOG")
    toast:SetClampedToScreen(true)
    local widgets = ns.UI.Widgets
    widgets.Box(toast, widgets.COLORS.window, widgets.COLORS.lineStrong)
    local mark = widgets.Dot(toast, 6)
    mark:SetPoint("TOPLEFT", 14, -16)
    toast.heading = widgets.Label(toast, "Routine", widgets.MUTED, widgets.FONTS.caption)
    toast.heading:SetPoint("TOPLEFT", 26, -14)
    toast.heading:SetPoint("RIGHT", -12, 0)
    toast.heading:SetWordWrap(false)
    body = widgets.Label(toast, "")
    body:SetPoint("TOPLEFT", 14, -36)
    body:SetWidth(322)
    body:SetWordWrap(true)
    local all = widgets.Button(toast, "All routines", 90, function()
        toast:Hide()
        ns.UI.SetMinimized(false)
        ns.UI.Routines.Show()
    end, "ghost")
    all:SetPoint("BOTTOMRIGHT", -12, 12)
    local read = widgets.Button(toast, "Read", 95, function()
        local id = toast.chatId
        toast:Hide()
        ns.Chat.Select(id)
        ns.UI.SetMinimized(false)
    end, "primary")
    read:SetPoint("BOTTOMLEFT", 12, 12)
    local dismiss = widgets.Button(toast, "Dismiss", 95, nil)
    dismiss:SetPoint("LEFT", read, "RIGHT", 8, 0)
    dismiss:SetScript("OnClick", function()
        ns.Transport.Send({ type = "dismiss_tip", chat = toast.chatId })
        for i = #(ns.notifications or {}), 1, -1 do
            if ns.notifications[i].id == toast.chatId then
                table.remove(ns.notifications, i)
            end
        end
        ns.Advice.RefreshAdvice()
    end)
    toast:Hide()
end
