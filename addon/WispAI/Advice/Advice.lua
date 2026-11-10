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
    toast:SetBackdrop({
        bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        tile = true,
        tileSize = 16,
        edgeSize = 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    toast:SetBackdropColor(0.09, 0.075, 0.055, 0.97)
    toast:SetBackdropBorderColor(0.43, 0.38, 0.28, 1)
    local title = toast:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    title:SetPoint("TOPLEFT", 12, -12)
    title:SetTextColor(0.84, 0.72, 0.43)
    title:SetText("Wisp routine")
    body = toast:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    body:SetPoint("TOPLEFT", 12, -36)
    body:SetWidth(325)
    body:SetJustifyH("LEFT")
    body:SetWordWrap(true)
    local read = CreateFrame("Button", nil, toast, "UIPanelButtonTemplate")
    read:SetSize(95, 24)
    read:SetPoint("BOTTOMLEFT", 12, 12)
    read:SetText("Read")
    read:SetScript("OnClick", function()
        local id = toast.chatId
        toast:Hide()
        ns.Chat.Select(id)
        ns.UI.SetMinimized(false)
    end)
    local dismiss = CreateFrame("Button", nil, toast, "UIPanelButtonTemplate")
    dismiss:SetSize(95, 24)
    dismiss:SetPoint("LEFT", read, "RIGHT", 8, 0)
    dismiss:SetText("Dismiss")
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
