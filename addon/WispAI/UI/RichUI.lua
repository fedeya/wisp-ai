local _, ns = ...
local uiWidgets = ns.UI.Widgets

local function fadePanel(panel)
    if not panel.entranceFade then
        local group = panel:CreateAnimationGroup()
        local alpha = group:CreateAnimation("Alpha")
        alpha:SetFromAlpha(0)
        alpha:SetToAlpha(1)
        alpha:SetDuration(0.18)
        panel.entranceFade = group
        panel:SetScript("OnHide", function(self)
            self.entranceFade:Stop()
        end)
    end
    panel.entranceFade:Play()
end

function ns.UI.RichSignature(value)
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
        parts[#parts + 1] = tostring(key) .. ":" .. ns.UI.RichSignature(value[key])
    end
    return "{" .. table.concat(parts, "\30") .. "}"
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
    uiWidgets.SetText(f, value)
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
            if ns.UI.LinkWidget then
                ns.UI.LinkWidget(entry)
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
local function tableUI(w, node, available, rendered)
    w.tableRows = w.tableRows or {}
    local y = line(w.title, rendered(node.title or ""), available, 0, 0)
    if y > 0 then
        y = y + 10
    end
    local rows = node._markdown and node._markdownRows or node.rows
    rows = rows or node.rows
    local pages = node._markdown and math.max(1, math.ceil(#rows / 20)) or 1
    w.page = math.min(pages, math.max(1, node._markdown and (w.page or 1) or 1))
    local offset = node._markdown and (w.page - 1) * 20 or 0
    local shown = node._markdown and math.min(20, #rows - offset) or #rows
    local count, padding, gap = math.max(1, #node.columns), 10, 12
    local wide = available >= math.max(340, count * 120)
    local columnWidth = math.max(1, (available - padding * 2 - gap * (count - 1)) / count)
    for index = 1, shown + 1 do
        local header = index == 1
        local row = w.tableRows[index]
        if not row then
            row = frame(w)
            row.cells, row.labels = {}, {}
            row.background = row:CreateTexture(nil, "BACKGROUND")
            row.background:SetAllPoints()
            if ns.UI.LinkWidget then
                ns.UI.LinkWidget(row)
            end
            w.tableRows[index] = row
        end
        row:SetWidth(available)
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", 0, -y)
        if header and not wide and shown > 0 then
            row:Hide()
        else
            row.background:SetColorTexture(
                0.20,
                0.18,
                0.13,
                header and 0.9 or ((offset + index) % 2 == 0 and 0.42 or 0.18)
            )
            local height, top = 0, padding
            for column, spec in ipairs(node.columns) do
                local value = header and spec.label or rows[offset + index - 1][column]
                local cell = row.cells[column]
                if not cell then
                    cell = font(row)
                    row.cells[column] = cell
                    row.labels[column] = font(row, "GameFontHighlightSmall")
                    row.labels[column]:SetTextColor(0.75, 0.67, 0.48)
                end
                local label = row.labels[column]
                cell:SetJustifyH(wide and string.upper(spec.align or "left") or "LEFT")
                cell:SetTextColor(
                    header and 0.95 or 0.89,
                    header and 0.83 or 0.85,
                    header and 0.52 or 0.75
                )
                if wide then
                    label:Hide()
                    height = math.max(
                        height,
                        line(
                            cell,
                            rendered(value or ""),
                            columnWidth,
                            padding + (column - 1) * (columnWidth + gap),
                            padding
                        )
                    )
                else
                    label:Hide()
                    if not header then
                        top = top
                            + line(
                                label,
                                rendered(spec.label),
                                math.max(1, available - padding * 2),
                                padding,
                                top
                            )
                            + 3
                    end
                    top = top
                        + line(
                            cell,
                            rendered(value or ""),
                            math.max(1, available - padding * 2),
                            padding,
                            top
                        )
                        + 9
                end
            end
            for column = count + 1, #row.cells do
                row.cells[column]:Hide()
                row.labels[column]:Hide()
            end
            row:SetHeight(wide and (height + padding * 2) or (top + padding - 9))
            row:Show()
            y = y + row:GetHeight() + 1
        end
    end
    for index = shown + 2, #w.tableRows do
        w.tableRows[index]:Hide()
    end
    if pages > 1 then
        if not w.pagerPrev then
            w.pagerPrev = CreateFrame("Button", nil, w, "UIPanelButtonTemplate")
            w.pagerNext = CreateFrame("Button", nil, w, "UIPanelButtonTemplate")
            w.pagerLabel = font(w, "GameFontHighlightSmall")
            w.pagerLabel:SetJustifyH("CENTER")
            w.pagerPrev:SetSize(28, 24)
            w.pagerNext:SetSize(28, 24)
            uiWidgets.SetText(w.pagerPrev, "<")
            uiWidgets.SetText(w.pagerNext, ">")
        end
        local function changePage(delta)
            w.page = math.max(1, math.min(pages, w.page + delta))
            if ns.Markdown.ReplyView and ns.Markdown.ReplyView.Invalidate then
                ns.Markdown.ReplyView.Invalidate()
            end
        end
        w.pagerPrev:SetScript("OnClick", function()
            changePage(-1)
        end)
        w.pagerNext:SetScript("OnClick", function()
            changePage(1)
        end)
        w.pagerPrev:SetEnabled(w.page > 1)
        w.pagerNext:SetEnabled(w.page < pages)
        w.pagerPrev:ClearAllPoints()
        w.pagerNext:ClearAllPoints()
        w.pagerPrev:SetPoint("TOPLEFT", 0, -y)
        w.pagerNext:SetPoint("TOPRIGHT", 0, -y)
        w.pagerPrev:Show()
        w.pagerNext:Show()
        local height = line(
            w.pagerLabel,
            string.format("%d-%d / %d", offset + 1, offset + shown, #rows),
            math.max(1, available - 72),
            36,
            y + 4
        )
        y = y + math.max(24, height + 8) + 8
    elseif w.pagerPrev then
        w.pagerPrev:Hide()
        w.pagerNext:Hide()
        w.pagerLabel:Hide()
    end
    if node.notice and node.notice ~= "" then
        w.notice = w.notice or font(w, "GameFontHighlightSmall")
        w.notice:SetTextColor(0.65, 0.63, 0.58)
        y = y + 6 + line(w.notice, rendered(node.notice), available, 0, y + 6)
    elseif w.notice then
        w.notice:Hide()
    end
    return y
end
function ns.UI.PanelAction(chat, message, node, values)
    if message.panelId and ns.Inline.AskPanel then
        ns.Inline.AskPanel(message.panelId, node, values)
        return
    end
    if chat.status == "working" then
        return
    end
    ns.Transport.Send({
        type = "ui_action",
        chat = chat.id,
        messageId = message.id,
        nodeId = node.id,
        values = values,
        context = ns.Character.Capture({ "character", "location" }),
    })
    chat.status = "working"
    ns.workStarted[chat.id] = GetTime()
    if ns.UI.Refresh then
        ns.UI.Refresh()
    end
end
function ns.UI.RenderRichUI(host, chat, message, width, collectWriting, animatePanels)
    if not host.widgets and ns.UI.LinkWidget then
        ns.UI.LinkWidget(host)
    end
    host.widgets, host.values, host.sourceValues =
        host.widgets or {}, host.values or {}, host.sourceValues or {}
    local widgets, values, children, nodes, used = host.widgets, host.values, {}, {}, {}
    local pending = false
    local function rendered(value)
        if not ns.UI.FormatText then
            return tostring(value)
        end
        local formatted, awaiting = ns.UI.FormatText(value, message.references)
        pending = pending or awaiting == true
        return formatted
    end
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
            if ns.UI.LinkWidget then
                ns.UI.LinkWidget(w)
            end
        end
        if w:GetParent() ~= parent then
            w:SetParent(parent)
        end
        used[node.id] = true
        w:SetWidth(available)
        local height = 0
        if node.kind == "row" or node.kind == "column" or node.kind == "card" then
            local padding = node.kind == "card" and 10 or 0
            local y = padding
            uiWidgets.SetText(w.title, node.title and rendered(node.title) or "")
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
        elseif node.kind == "table" then
            height = tableUI(w, node, available, node._markdown and tostring or rendered)
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
            uiWidgets.SetText(w.title, rendered(value or ""))
            height = math.max(18, w.title:GetStringHeight())
        elseif node.kind == "divider" then
            w.title:SetWidth(available)
            uiWidgets.SetText(w.title, "________________")
            height = 12
        elseif node.kind == "button" then
            uiWidgets.SetText(w.title, "")
            w.control:ClearAllPoints()
            w.control:SetPoint("TOPLEFT", 0, 0)
            w.control:SetWidth(available)
            uiWidgets.SetText(w.control, (node.label or "Continue"):gsub("|", "||"))
            w.control:SetEnabled(chat.status ~= "working")
            w.control:SetScript("OnClick", function()
                ns.UI.PanelAction(chat, message, node, values)
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
                uiWidgets.SetText(w.title, rendered(title))
                height = math.max(28, w.title:GetStringHeight() + 10)
                w.control:SetScript("OnClick", function(self)
                    values[node.id] = self:GetChecked() == true
                end)
            elseif node.kind == "select" then
                w.title:SetWidth(available)
                uiWidgets.SetText(w.title, rendered(title))
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
                uiWidgets.SetText(w.control, selected():gsub("|", "||"))
                w.control:SetScript("OnClick", function()
                    if MenuUtil and MenuUtil.CreateContextMenu then
                        MenuUtil.CreateContextMenu(w.control, function(_, root)
                            for _, option in ipairs(node.options) do
                                local value = option.value
                                root:CreateRadio(option.label:gsub("|", "||"), function()
                                    return values[node.id] == value
                                end, function()
                                    values[node.id] = value
                                    uiWidgets.SetText(w.control, selected():gsub("|", "||"))
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
                        uiWidgets.SetText(w.control, selected():gsub("|", "||"))
                    end
                end)
                height = top + 28
            else
                w.title:SetWidth(available)
                uiWidgets.SetText(w.title, rendered(title .. ": " .. tostring(values[node.id])))
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
                    uiWidgets.SetText(
                        w.title,
                        rendered(title .. ": " .. string.format("%.2f", value))
                    )
                end)
                height = top + 22
            end
            w.control:SetEnabled(chat.status ~= "working")
        elseif node.kind == "progress" then
            w.title:SetWidth(available)
            uiWidgets.SetText(
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
    if ns.Markdown and ns.Markdown.TextStyle then
        ns.Markdown.TextStyle.Hide(host.prose)
    end
    local proseCount = 0
    local writingUnits = collectWriting and {} or nil
    local function indent(value)
        return math.max(0, math.min(tonumber(value) or 0, math.max(0, width - 40)))
    end
    local function root(node, left)
        left = indent(left)
        local h = build(node, host, math.max(1, width - left), 0)
        local w = widgets[node.id]
        w:ClearAllPoints()
        w:SetPoint("TOPLEFT", left, -y)
        y = y + h + 8
        local presented = host.presentedRoots
        if presented and not node._markdown and not presented[node.id] then
            presented[node.id] = true
            if animatePanels and w:IsVisible() then
                fadePanel(w)
            end
        end
    end
    if
        message.parts
        and #message.parts > 0
        and not message._markdownSimple
        and (message._markdown or (message.ui and #message.ui > 0))
    then
        for _, part in ipairs(message.parts) do
            if part.type == "ui" then
                local node = nodes[part.id]
                if node and not node.parent then
                    root(node, part.indent)
                end
            elseif part.type == "text" and part.text ~= "" then
                local unit
                if
                    part._markdown
                    and (part.runs or part.style == "rule")
                    and ns.Markdown.TextStyle
                then
                    y, proseCount, unit = ns.Markdown.TextStyle.Render(
                        host,
                        host.prose,
                        part,
                        width,
                        y,
                        proseCount,
                        collectWriting
                    )
                    y = y + 8
                else
                    proseCount = proseCount + 1
                    local f = host.prose[proseCount] or font(host)
                    host.prose[proseCount] = f
                    f:ClearAllPoints()
                    local left = indent(part.indent)
                    local style = "GameFontNormal"
                    if part.style == "heading" then
                        style = (part.level or 1) == 1 and "GameFontNormalHuge"
                            or "GameFontNormalLarge"
                        f:SetTextColor(0.95, 0.83, 0.52)
                    elseif part.style == "code" then
                        style = "GameFontHighlightSmall"
                        f:SetTextColor(0.75, 0.79, 0.83)
                    elseif part.style == "quote" then
                        f:SetTextColor(0.65, 0.63, 0.58)
                    else
                        f:SetTextColor(0.89, 0.85, 0.75)
                    end
                    if f.markdownStyle ~= style then
                        f:SetFontObject(_G[style] or style)
                        f.markdownStyle = style
                    end
                    f:SetPoint("TOPLEFT", left, -y)
                    f:SetWidth(math.max(1, width - left))
                    uiWidgets.SetText(f, part._markdown and part.text or rendered(part.text))
                    f:Show()
                    y = y + f:GetStringHeight() + 8
                    if writingUnits then
                        unit = { fonts = { f } }
                    end
                end
                if unit then
                    writingUnits[#writingUnits + 1] = unit
                end
            end
        end
    else
        for _, node in ipairs(children._root or {}) do
            root(node)
        end
    end
    if ns.Markdown and ns.Markdown.TextStyle then
        ns.Markdown.TextStyle.Hide(host.prose, proseCount + 1)
    else
        for index, f in ipairs(host.prose) do
            if index > proseCount then
                f:Hide()
            end
        end
    end
    for id, w in pairs(widgets) do
        if not used[id] and w:IsShown() then
            w:Hide()
        end
    end
    host:SetWidth(width)
    host:SetHeight(math.max(1, y))
    return y, pending, writingUnits
end
