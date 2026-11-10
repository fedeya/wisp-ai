local _, C = ...
local frames, panels = {}, {}
local function clone(value)
    if type(value) ~= "table" then
        return value
    end
    local copy = {}
    for k, v in pairs(value) do
        copy[k] = clone(v)
    end
    return copy
end
local function matches(panel)
    local ok, key = pcall(C_EncodingUtil.DeserializeJSON, panel.characterKey or "")
    return ok and type(key) == "table" and key[2] == GetRealmName() and key[3] == UnitName("player")
end
local function keyFor(panel)
    return panel.characterKey .. ":" .. panel.id
end
local function stateFor(panel)
    C.db.panelState = C.db.panelState or {}
    local key = keyFor(panel)
    C.db.panelState[key] = C.db.panelState[key] or {}
    return C.db.panelState[key]
end
local function reading(binding)
    if binding.source == "item_count" then
        local get = C_Item and C_Item.GetItemCount or GetItemCount
        if not get then
            return nil
        end
        return get(binding.itemId, false, false, false, false)
    elseif binding.source == "money" then
        return GetMoney and GetMoney()
    elseif binding.source == "level" then
        return UnitLevel("player")
    elseif binding.source == "quest_completed" then
        if not C_QuestLog or not C_QuestLog.IsQuestFlaggedCompleted then
            return nil
        end
        local completed = C_QuestLog.IsQuestFlaggedCompleted(binding.questId)
        if completed == nil then
            return nil
        end
        return completed and 1 or 0
    end
end
function C.BoundPanel(panel)
    local view = clone(panel)
    local nodes = {}
    for _, node in ipairs(view.ui or {}) do
        nodes[node.id] = node
    end
    for _, binding in ipairs(panel.bindings or {}) do
        local node = nodes[binding.nodeId]
        if node then
            local ok, value = pcall(reading, binding)
            local known = ok and type(value) == "number" and value == value and value >= 0
            if node.kind == "progress" then
                node.value = known and math.min(1, value / (binding.target or 1)) or 0
                node.unavailable = not known
            else
                if not known then
                    node.value = "Unavailable"
                elseif binding.source == "quest_completed" then
                    node.value = value == 1 and "Completed" or "Not completed"
                elseif binding.source == "money" then
                    node.value = string.format(
                        "%dg %ds %dc",
                        math.floor(value / 10000),
                        math.floor(value / 100) % 100,
                        value % 100
                    )
                else
                    node.value = tostring(value)
                        .. (binding.target and (" / " .. binding.target) or "")
                end
                if binding.source == "item_count" then
                    node.detail = known
                            and (binding.target and (math.max(0, binding.target - value) .. " remaining; bags only") or "Bags only")
                        or "Bag count unavailable"
                end
            end
        end
    end
    return view
end
local function build(panel, index)
    local state = stateFor(panel)
    local key = keyFor(panel)
    local w = frames[key]
    if not w then
        w = CreateFrame("Frame", nil, UIParent, "BackdropTemplate")
        frames[key] = w
        w:SetSize(310, 180)
        w:SetFrameStrata("DIALOG")
        w:SetClampedToScreen(true)
        w:SetMovable(true)
        w:EnableMouse(true)
        w:SetBackdrop({
            bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
            edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
            tile = true,
            tileSize = 16,
            edgeSize = 12,
            insets = { left = 3, right = 3, top = 3, bottom = 3 },
        })
        w:SetBackdropColor(0.09, 0.075, 0.055, 0.96)
        w:SetBackdropBorderColor(0.43, 0.38, 0.28, 1)
        w.title = w:CreateFontString(nil, "OVERLAY", "GameFontNormal")
        w.title:SetPoint("TOPLEFT", 12, -11)
        w.title:SetPoint("RIGHT", -65, 0)
        w.title:SetJustifyH("LEFT")
        w.title:SetWordWrap(false)
        w.title:SetTextColor(0.84, 0.72, 0.43)
        w.mini = CreateFrame("Button", nil, w, "UIPanelButtonTemplate")
        w.mini:SetSize(23, 21)
        w.mini:SetPoint("TOPRIGHT", -34, -7)
        w.mini:SetScript("OnClick", function()
            state.minimized = not state.minimized
            C.RefreshPanels()
        end)
        w.close = CreateFrame("Button", nil, w, "UIPanelButtonTemplate")
        w.close:SetSize(23, 21)
        w.close:SetPoint("TOPRIGHT", -8, -7)
        w.close:SetText("x")
        w.close:SetScript("OnClick", function()
            state.hidden = true
            w:Hide()
        end)
        w.scroll = CreateFrame("ScrollFrame", nil, w, "UIPanelScrollFrameTemplate")
        w.scroll:SetPoint("TOPLEFT", 12, -40)
        w.scroll:SetPoint("BOTTOMRIGHT", -29, 10)
        w.host = CreateFrame("Frame", nil, w.scroll)
        w.host:SetSize(265, 1)
        w.host._wispScroll = w.scroll
        w.scroll:SetScrollChild(w.host)
        state.values = state.values or {}
        state.sourceValues = state.sourceValues or {}
        w.host.values = state.values
        w.host.sourceValues = state.sourceValues
        w.scroll:EnableMouseWheel(true)
        w.scroll:SetScript("OnMouseWheel", function(_, delta)
            w.scroll:SetVerticalScroll(
                math.max(
                    0,
                    math.min(
                        w.scroll:GetVerticalScrollRange(),
                        w.scroll:GetVerticalScroll() - delta * 40
                    )
                )
            )
        end)
        w:RegisterForDrag("LeftButton")
        w:SetScript("OnDragStart", function()
            w:StartMoving()
        end)
        w:SetScript("OnDragStop", function()
            w:StopMovingOrSizing()
            local p, _, r, x, y = w:GetPoint()
            state.position = { p, r, x, y }
        end)
        if state.position then
            local p = state.position
            w:SetPoint(p[1], UIParent, p[2], p[3], p[4])
        else
            w:SetPoint(
                "RIGHT",
                UIParent,
                "RIGHT",
                -45 - math.floor((index - 1) / 3) * 320,
                -30 - ((index - 1) % 3) * 190
            )
        end
    end
    local view = C.BoundPanel(panel)
    local sourceSignature = C.RichSignature(view)
        .. tostring(state.minimized)
        .. tostring(state.hidden)
    local signature = sourceSignature
        .. "\31"
        .. (w.inlineMarkdownPending and C.Markdown.Cache.revision or "")
    if w.signature ~= signature then
        w.title:SetText(panel.title:gsub("|", "||"))
        w.mini:SetText(state.minimized and "+" or "-")
        local height, pending = C.RenderRichUI(
            w.host,
            { id = "panel:" .. panel.id, status = "idle" },
            {
                id = "persistent:" .. panel.id,
                panelId = panel.id,
                ui = view.ui,
                references = view.references,
            },
            265
        )
        w.inlineMarkdownPending = pending == true
        w.signature = sourceSignature
            .. "\31"
            .. (w.inlineMarkdownPending and C.Markdown.Cache.revision or "")
        w.scroll:SetShown(not state.minimized)
        w:SetHeight(state.minimized and 35 or math.min(460, math.max(90, height + 55)))
    end
    w:SetShown(not state.hidden)
end
function C.RefreshPanels()
    if not C.db then
        return
    end
    local used = {}
    for index, panel in ipairs(panels) do
        if matches(panel) then
            used[keyFor(panel)] = true
            build(panel, index)
        end
    end
    for key, w in pairs(frames) do
        if not used[key] then
            w:Hide()
        end
    end
end
function C.ReceivePanels(data, command)
    panels = data or {}
    C.db.cachedPanels = panels
    if command and command.seq ~= C.db.lastPanelCommand then
        C.db.lastPanelCommand = command.seq
        for _, panel in ipairs(panels) do
            if
                panel.id == command.id
                and panel.characterKey == command.characterKey
                and matches(panel)
            then
                stateFor(panel).hidden = command.action == "hide"
            end
        end
    end
    C.RefreshPanels()
end
function C.InitPanels()
    panels = C.db.cachedPanels or {}
    C.RefreshPanels()
    local events = CreateFrame("Frame")
    for _, event in ipairs({
        "BAG_UPDATE_DELAYED",
        "PLAYER_MONEY",
        "PLAYER_LEVEL_UP",
        "QUEST_LOG_UPDATE",
        "PLAYER_EQUIPMENT_CHANGED",
    }) do
        events:RegisterEvent(event)
    end
    local scheduled = false
    events:SetScript("OnEvent", function()
        if scheduled then
            return
        end
        scheduled = true
        C_Timer.After(0.3, function()
            scheduled = false
            C.RefreshPanels()
        end)
    end)
end
function C.ShowPanels()
    for _, panel in ipairs(panels) do
        if matches(panel) then
            stateFor(panel).hidden = false
        end
    end
    C.RefreshPanels()
end
