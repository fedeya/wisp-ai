local _, C = ...
function C.RichSignature(value)
    if type(value) ~= "table" then
        return tostring(value)
    end
    local keys, parts = {}, {}
    for key in pairs(value) do
        keys[#keys + 1] = key
    end
    table.sort(keys, function(a, b)
        return tostring(a) < tostring(b)
    end)
    for _, key in ipairs(keys) do
        parts[#parts + 1] = tostring(key) .. ":" .. C.RichSignature(value[key])
    end
    return "{" .. table.concat(parts, "\30") .. "}"
end
local function text(font, value)
    if font.value ~= value then
        font.value = value
        font:SetText(value)
    end
end
local function font(parent, style)
    local f = parent:CreateFontString(nil, "OVERLAY", style or "GameFontNormal")
    f:SetJustifyH("LEFT")
    f:SetWordWrap(true)
    f:SetSpacing(3)
    f:SetTextColor(0.89, 0.85, 0.75)
    return f
end
local function line(f, value, width, x, y)
    f:SetWidth(math.max(1, width))
    f:ClearAllPoints()
    f:SetPoint("TOPLEFT", x, -y)
    text(f, value)
    f:SetShown(value ~= "")
    return value ~= "" and f:GetStringHeight() or 0
end
local function metricFonts(w)
    w.metric = font(w, "GameFontNormalLarge")
    w.metric:SetTextColor(0.95, 0.83, 0.52)
    w.detail = font(w, "GameFontHighlightSmall")
    w.detail:SetTextColor(0.65, 0.63, 0.58)
end
local function frame(parent, kind)
    local w = CreateFrame("Frame", nil, parent, kind == "card" and "BackdropTemplate" or nil)
    if kind == "card" then
        w:SetBackdrop({
            bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
            edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
            tile = true,
            tileSize = 16,
            edgeSize = 10,
            insets = { left = 3, right = 3, top = 3, bottom = 3 },
        })
        w:SetBackdropColor(0.13, 0.11, 0.08, 0.95)
        w:SetBackdropBorderColor(0.43, 0.38, 0.28, 1)
    end
    return w
end
local function comparison(w, node, available, rendered)
    w.entries = w.entries or {}
    local y = line(w.title, rendered(node.title or ""), available, 0, 0)
    if y > 0 then
        y = y + 10
    end
    local maximum, baseline, baselineLabel = 0, nil, nil
    for _, item in ipairs(node.items) do
        maximum = math.max(maximum, item.value)
        if item.id == node.baseline then
            baseline = item.value
            baselineLabel = item.label
        end
    end
    for index, item in ipairs(node.items) do
        local entry = w.entries[index]
        if not entry then
            entry = frame(w, "card")
            entry.title = font(entry)
            metricFonts(entry)
            entry.badge = font(entry, "GameFontHighlightSmall")
            entry.badge:SetTextColor(0.62, 0.85, 0.59)
            entry.delta = font(entry, "GameFontHighlightSmall")
            entry.delta:SetTextColor(0.72, 0.69, 0.61)
            entry.bar = CreateFrame("StatusBar", nil, entry)
            entry.bar:SetStatusBarTexture("Interface\\Buttons\\WHITE8X8")
            entry.bar:SetMinMaxValues(0, 1)
            entry.bar:SetHeight(4)
            entry.track = entry.bar:CreateTexture(nil, "BACKGROUND")
            entry.track:SetAllPoints()
            entry.track:SetColorTexture(0.24, 0.22, 0.17, 0.6)
            if C.LinkWidget then
                C.LinkWidget(entry)
            end
            w.entries[index] = entry
        end
        local winner = item.id == node.winner
        entry:SetBackdropColor(winner and 0.10 or 0.07, winner and 0.15 or 0.065, 0.065, 0.95)
        entry:SetBackdropBorderColor(
            winner and 0.52 or 0.25,
            winner and 0.66 or 0.23,
            winner and 0.35 or 0.17,
            1
        )
        entry.bar:SetStatusBarColor(
            winner and 0.54 or 0.64,
            winner and 0.76 or 0.54,
            winner and 0.39 or 0.32
        )
        entry:SetWidth(available)
        entry:ClearAllPoints()
        entry:SetPoint("TOPLEFT", 0, -y)
        local inner, top = math.max(1, available - 20), 10
        local badge = winner and rendered(node.winnerLabel or "Best result") or ""
        local badgeHeight = line(entry.badge, badge, inner, 10, top)
        if badgeHeight > 0 then
            top = top + badgeHeight + 5
        end
        -- Stack on narrow chat windows; long localized labels wrap independently
        -- from the number so neither can collide or truncate the other.
        local wide = inner >= 340
        local valueWidth = wide and math.min(150, inner * 0.38) or inner
        local labelWidth = wide and (inner - valueWidth - 12) or inner
        entry.metric:SetJustifyH(wide and "RIGHT" or "LEFT")
        local labelHeight = line(entry.title, rendered(item.label), labelWidth, 10, top)
        local value = string.format("%." .. (node.precision or 1) .. "f", item.value)
            .. (node.unit and (" " .. node.unit) or "")
        local delta = baseline
                and baseline > 0
                and item.id ~= node.baseline
                and (string.format("%+.1f%% vs. ", (item.value / baseline - 1) * 100) .. baselineLabel)
            or ""
        local valueX = wide and (10 + inner - valueWidth) or 10
        local valueTop = wide and top or (top + labelHeight + 4)
        local valueHeight = line(entry.metric, rendered(value), valueWidth, valueX, valueTop)
        top = top
            + (wide and math.max(labelHeight, valueHeight) or (labelHeight + 4 + valueHeight))
            + 4
        -- Use the whole row for the reference, including long localized spell
        -- names, rather than squeezing it into the numeric column.
        local deltaHeight = line(entry.delta, rendered(delta), inner, 10, top)
        if deltaHeight > 0 then
            top = top + deltaHeight + 3
        end
        top = top + 5
        entry.bar:ClearAllPoints()
        entry.bar:SetPoint("TOPLEFT", 10, -top)
        entry.bar:SetWidth(inner)
        entry.bar:SetValue(maximum > 0 and item.value / maximum or 0)
        top = top + 4
        local detail = rendered(item.detail or "")
        if detail ~= "" then
            top = top + 7
        end
        top = top + line(entry.detail, detail, inner, 10, top)
        entry:SetHeight(top + 10)
        entry:Show()
        y = y + entry:GetHeight() + 6
    end
    for i = #node.items + 1, #w.entries do
        w.entries[i]:Hide()
    end
    return y - 6
end
function C.PanelAction(chat, message, node, values)
    if message.panelId and C.AskPanel then
        C.AskPanel(message.panelId, node, values)
        return
    end
    if chat.status == "working" then
        return
    end
    C.Send({
        type = "ui_action",
        chat = chat.id,
        messageId = message.id,
        nodeId = node.id,
        values = values,
        context = C.Capture({ "character", "location" }),
    })
    chat.status = "working"
    C.workStarted[chat.id] = GetTime()
    if C.Refresh then
        C.Refresh()
    end
end
function C.RenderRichUI(host, chat, message, width)
    host.widgets, host.values, host.sourceValues =
        host.widgets or {}, host.values or {}, host.sourceValues or {}
    local widgets, values, children, nodes, used = host.widgets, host.values, {}, {}, {}
    for _, node in ipairs(message.ui or {}) do
        nodes[node.id] = node
        local parent = node.parent or "_root"
        children[parent] = children[parent] or {}
        children[parent][#children[parent] + 1] = node
    end
    local function build(node, parent, available, depth)
        if depth > 5 then
            return 0
        end
        local w = widgets[node.id]
        if w and w.nodeKind ~= node.kind then
            w:Hide()
            widgets[node.id] = nil
            values[node.id] = nil
            host.sourceValues[node.id] = nil
            w = nil
        end
        if not w then
            w = frame(parent, node.kind)
            widgets[node.id] = w
            w.nodeKind = node.kind
            w.title = font(w)
            w.title:SetPoint("TOPLEFT", 0, 0)
            if node.kind == "stat" then
                metricFonts(w)
            elseif node.kind == "button" or node.kind == "select" then
                w.control = CreateFrame("Button", nil, w, "UIPanelButtonTemplate")
                w.control:SetHeight(25)
            elseif node.kind == "toggle" then
                w.control = CreateFrame("CheckButton", nil, w, "UICheckButtonTemplate")
                w.control:SetSize(26, 26)
            elseif node.kind == "slider" then
                w.control = CreateFrame("Slider", nil, w)
                w.control:SetHeight(14)
                w.control:SetOrientation("HORIZONTAL")
                w.control:SetThumbTexture("Interface\\Buttons\\UI-SliderBar-Button-Horizontal")
                w.control:SetObeyStepOnDrag(true)
            elseif node.kind == "progress" then
                w.control = CreateFrame("StatusBar", nil, w)
                w.control:SetHeight(8)
                w.control:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
                w.control:SetStatusBarColor(0.72, 0.6, 0.32)
                w.control:SetMinMaxValues(0, 1)
            end
            if C.LinkWidget then
                C.LinkWidget(w)
            end
        end
        if w:GetParent() ~= parent then
            w:SetParent(parent)
        end
        used[node.id] = true
        w:SetWidth(available)
        local rendered = C.FormatText
                and function(value)
                    return C.FormatText(value, message.references)
                end
            or tostring
        local height = 0
        if node.kind == "row" or node.kind == "column" or node.kind == "card" then
            local padding = node.kind == "card" and 10 or 0
            local y = padding
            text(w.title, node.title and rendered(node.title) or "")
            w.title:SetWidth(math.max(30, available - 2 * padding))
            w.title:ClearAllPoints()
            w.title:SetPoint("TOPLEFT", padding, -padding)
            if node.title and node.title ~= "" then
                y = y + w.title:GetStringHeight() + 8
            end
            local list = children[node.id] or {}
            local each = node.kind == "row"
                    and math.max(
                        35,
                        (available - 2 * padding - math.max(0, #list - 1) * 8) / math.max(1, #list)
                    )
                or available - 2 * padding
            local tallest = 0
            for index, child in ipairs(list) do
                local h = build(child, w, each, depth + 1)
                local cw = widgets[child.id]
                if cw then
                    cw:ClearAllPoints()
                    cw:SetPoint(
                        "TOPLEFT",
                        node.kind == "row" and (padding + (index - 1) * (each + 8)) or padding,
                        -y
                    )
                end
                if node.kind == "row" then
                    tallest = math.max(tallest, h)
                else
                    y = y + h + 8
                end
            end
            height = (node.kind == "row" and y + tallest or y) + padding
        elseif node.kind == "comparison" then
            height = comparison(w, node, available, rendered)
        elseif node.kind == "stat" then
            local y = line(w.title, rendered(node.label or ""), available, 0, 0) + 4
            y = y + line(w.metric, rendered(node.value or ""), available, 0, y)
            local detail = rendered(node.detail or "")
            if detail ~= "" then
                y = y + 5
            end
            height = y + line(w.detail, detail, available, 0, y)
        elseif node.kind == "text" or node.kind == "reference" then
            local value = node.kind == "reference" and ("[[ref:" .. node.reference .. "]]")
                or node.text
            w.title:SetWidth(available)
            text(w.title, rendered(value or ""))
            height = math.max(18, w.title:GetStringHeight())
        elseif node.kind == "divider" then
            w.title:SetWidth(available)
            text(w.title, "________________")
            height = 12
        elseif node.kind == "button" then
            text(w.title, "")
            w.control:ClearAllPoints()
            w.control:SetPoint("TOPLEFT", 0, 0)
            w.control:SetWidth(available)
            text(w.control, (node.label or "Continue"):gsub("|", "||"))
            w.control:SetEnabled(chat.status ~= "working")
            w.control:SetScript("OnClick", function()
                C.PanelAction(chat, message, node, values)
            end)
            height = 27
        elseif node.kind == "toggle" or node.kind == "select" or node.kind == "slider" then
            if host.sourceValues[node.id] ~= node.value then
                if host.sourceValues[node.id] ~= nil or values[node.id] == nil then
                    values[node.id] = node.value
                end
                host.sourceValues[node.id] = node.value
            end
            if values[node.id] == nil then
                values[node.id] = node.value
            end
            if node.kind == "select" then
                local valid = false
                for _, option in ipairs(node.options) do
                    if option.value == values[node.id] then
                        valid = true
                    end
                end
                if not valid then
                    values[node.id] = node.value
                end
            end
            if node.kind == "slider" then
                values[node.id] = math.max(node.min, math.min(node.max, values[node.id]))
            end
            local title = node.label or ""
            if node.kind == "toggle" then
                w.control:ClearAllPoints()
                w.control:SetPoint("TOPLEFT", 0, 0)
                w.control:SetChecked(values[node.id])
                w.title:ClearAllPoints()
                w.title:SetPoint("TOPLEFT", 30, -5)
                w.title:SetWidth(math.max(20, available - 30))
                text(w.title, rendered(title))
                height = math.max(28, w.title:GetStringHeight() + 10)
                w.control:SetScript("OnClick", function(self)
                    values[node.id] = self:GetChecked() == true
                end)
            elseif node.kind == "select" then
                w.title:SetWidth(available)
                text(w.title, rendered(title))
                local top = w.title:GetStringHeight() + 5
                w.control:ClearAllPoints()
                w.control:SetPoint("TOPLEFT", 0, -top)
                w.control:SetWidth(available)
                local function selected()
                    for _, option in ipairs(node.options or {}) do
                        if option.value == values[node.id] then
                            return option.label
                        end
                    end
                    return "Choose"
                end
                text(w.control, selected():gsub("|", "||"))
                w.control:SetScript("OnClick", function()
                    if MenuUtil and MenuUtil.CreateContextMenu then
                        MenuUtil.CreateContextMenu(w.control, function(_, root)
                            for _, option in ipairs(node.options) do
                                local value = option.value
                                root:CreateRadio(option.label:gsub("|", "||"), function()
                                    return values[node.id] == value
                                end, function()
                                    values[node.id] = value
                                    text(w.control, selected():gsub("|", "||"))
                                end)
                            end
                        end)
                    else
                        local index = 1
                        for i, option in ipairs(node.options) do
                            if option.value == values[node.id] then
                                index = i % #node.options + 1
                                break
                            end
                        end
                        values[node.id] = node.options[index].value
                        text(w.control, selected():gsub("|", "||"))
                    end
                end)
                height = top + 28
            else
                w.title:SetWidth(available)
                text(w.title, rendered(title .. ": " .. tostring(values[node.id])))
                local top = w.title:GetStringHeight() + 7
                w.control:ClearAllPoints()
                w.control:SetPoint("TOPLEFT", 3, -top)
                w.control:SetWidth(math.max(20, available - 6))
                w.control:SetScript("OnValueChanged", nil)
                w.control:SetMinMaxValues(node.min, node.max)
                w.control:SetValueStep(node.step)
                w.control:SetValue(values[node.id])
                w.control:SetScript("OnValueChanged", function(_, value)
                    values[node.id] = value
                    text(w.title, rendered(title .. ": " .. string.format("%.2f", value)))
                end)
                height = top + 22
            end
            w.control:SetEnabled(chat.status ~= "working")
        elseif node.kind == "progress" then
            w.title:SetWidth(available)
            text(
                w.title,
                rendered(
                    (node.label or "")
                        .. (
                            node.unavailable and "  Unavailable"
                            or ("  " .. math.floor(node.value * 100 + 0.5) .. "%")
                        )
                )
            )
            w.control:ClearAllPoints()
            w.control:SetPoint("TOPLEFT", 0, -w.title:GetStringHeight() - 5)
            w.control:SetWidth(available)
            w.control:SetValue(node.value)
            w.control:SetShown(not node.unavailable)
            height = w.title:GetStringHeight() + 20
        end
        w:SetHeight(math.max(1, height))
        if not w:IsShown() then
            w:Show()
        end
        return height
    end
    local y = 0
    host.prose = host.prose or {}
    local proseCount = 0
    local function root(node)
        local h = build(node, host, width, 0)
        local w = widgets[node.id]
        w:ClearAllPoints()
        w:SetPoint("TOPLEFT", 0, -y)
        y = y + h + 8
    end
    if message.parts and #message.parts > 0 and message.ui and #message.ui > 0 then
        for _, part in ipairs(message.parts) do
            if part.type == "ui" then
                local node = nodes[part.id]
                if node and not node.parent then
                    root(node)
                end
            elseif part.type == "text" and part.text ~= "" then
                proseCount = proseCount + 1
                local f = host.prose[proseCount] or font(host)
                host.prose[proseCount] = f
                f:ClearAllPoints()
                f:SetPoint("TOPLEFT", 0, -y)
                f:SetWidth(width)
                text(f, C.FormatText and C.FormatText(part.text, message.references) or part.text)
                f:Show()
                y = y + f:GetStringHeight() + 8
            end
        end
    else
        for _, node in ipairs(children._root or {}) do
            root(node)
        end
    end
    for index, f in ipairs(host.prose) do
        if index > proseCount then
            f:Hide()
        end
    end
    for id, w in pairs(widgets) do
        if not used[id] and w:IsShown() then
            w:Hide()
        end
    end
    host:SetWidth(width)
    host:SetHeight(math.max(1, y))
    return y
end
