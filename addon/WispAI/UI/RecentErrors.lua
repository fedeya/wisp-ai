local _, ns = ...
local label, box, button = ns.UI.Widgets.Label, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local frame, toggle, coverage, editor, scroll, explain, send, empty
local rows, selected, offset, selectedChat = {}, nil, 0, nil
local function discard()
    selected = nil
    if editor then
        if editor:GetText() ~= "" then
            editor:SetText("")
        end
        editor:ClearFocus()
    end
end
local function find(data, id)
    for _, record in ipairs(data.records) do
        if record.id == id then
            return record
        end
    end
end

-- Fit a bounded preview to this popup's actual button text region. The full
-- retained observation remains available in the scrollable question editor.
local function setNoticeText(row, record)
    local preview, shortened = ns.Shared.Text.TruncateUtf8Bytes(record.text, 64)
    local prefix = (record.id == selected and "> " or "")
        .. math.floor(record.latestAge)
        .. "s x"
        .. record.count
        .. " "
    local font = row:GetFontString()
    repeat
        row:SetText(
            prefix .. preview:gsub("|", "||") .. ((shortened or record.truncated) and "…" or "")
        )
        local width = font.GetUnboundedStringWidth and font:GetUnboundedStringWidth()
            or font:GetStringWidth()
        if width <= 372 or #preview == 0 then
            break
        end
        preview = ns.Shared.Text.TruncateUtf8Bytes(preview, math.max(0, #preview - 4))
        shortened = true
    until false
end

function ns.UI.RecentErrors.Refresh()
    if not frame then
        return
    end
    local data = ns.RecentErrors.Read()
    empty:SetShown(#data.records == 0)
    if not find(data, selected) or selectedChat ~= ns.active then
        discard()
    end
    toggle:SetText(data.enabled and "Disable & clear" or "Enable local capture")
    coverage:SetText(
        string.format(
            "%s | %d retained / 120s | omitted %d | expired %d | evicted %d | clipped %d",
            data.enabled and ("On for " .. math.floor(data.captureAge) .. "s") or "Off (default)",
            #data.records,
            data.omitted,
            data.expired,
            data.evicted,
            data.clipped
        )
    )
    offset = math.max(0, math.min(offset, #data.records - 3))
    for index, row in ipairs(rows) do
        local record = data.records[#data.records - offset - index + 1]
        row.id = record and record.id
        row:SetShown(record ~= nil)
        if record then
            setNoticeText(row, record)
        end
    end
    explain:SetEnabled(selected ~= nil)
    send:SetEnabled(selected ~= nil and editor:GetText():match("%S") ~= nil)
end

function ns.UI.RecentErrors.Select(id)
    local record = find(ns.RecentErrors.Read(), id)
    if not record then
        discard()
        return false
    end
    discard()
    selected, selectedChat = id, ns.active
    ns.UI.RecentErrors.Refresh()
    return true
end

function ns.UI.RecentErrors.Explain()
    local record = find(ns.RecentErrors.Read(), selected)
    if not record then
        discard()
        return
    end
    editor:SetText(
        "What did this observed game notice mean, and what can I check?\n"
            .. record.text
            .. (record.truncated and " [capture clipped]" or "")
            .. "\nThis is a historical UI_ERROR_MESSAGE, not proof of its cause or that it was displayed."
    )
    editor:SetFocus()
    ns.UI.RecentErrors.Refresh()
end

function ns.UI.RecentErrors.Send()
    ns.UI.RecentErrors.Refresh()
    if selected and editor:GetText():match("%S") and ns.Chat.Submit(editor:GetText()) then
        discard()
        ns.UI.RecentErrors.Refresh()
    end
end

-- A separate clamped 420x310 review surface: never mounts inside the ~219x112
-- minimum chat viewport, never uses ns.draft or writes any SavedVariables.
function ns.UI.RecentErrors.Open()
    if frame then
        frame:Show()
        ns.UI.RecentErrors.Refresh()
        return
    end
    frame = CreateFrame("Frame", "WispAIRecentErrors", UIParent, "BackdropTemplate")
    frame:SetSize(420, 310)
    frame:SetPoint("CENTER")
    frame:SetClampedToScreen(true)
    frame:SetFrameStrata("FULLSCREEN_DIALOG")
    frame:EnableMouse(true)
    box(frame, { 0.075, 0.065, 0.05, 0.99 }, 16)
    local title = label(frame, "Recent game notices · local review", ns.UI.Widgets.GOLD)
    title:SetPoint("TOPLEFT", 12, -12)
    local close = button(frame, "X", 24, function()
        discard()
        frame:Hide()
    end)
    close:SetPoint("TOPRIGHT", -8, -6)
    toggle = button(frame, "Enable local capture", 160, function()
        ns.RecentErrors.SetEnabled(not ns.RecentErrors.Read().enabled)
    end)
    toggle:SetPoint("TOPLEFT", 12, -34)
    local refresh = button(frame, "Refresh", 80, ns.UI.RecentErrors.Refresh)
    refresh:SetPoint("TOPRIGHT", -12, -34)
    local guidance = label(frame, "Wheel list\nAges at refresh", ns.UI.Widgets.MUTED)
    guidance:SetPoint("TOPLEFT", 182, -34)
    guidance:SetSize(140, 24)
    guidance:SetFontObject("GameFontNormalSmall")
    coverage = label(frame, "", ns.UI.Widgets.MUTED)
    coverage:SetPoint("TOPLEFT", 12, -60)
    coverage:SetSize(396, 28)
    coverage:SetFontObject("GameFontNormalSmall")
    for i = 1, 3 do
        local row = button(frame, "", 396, function(self)
            ns.UI.RecentErrors.Select(self.id)
        end)
        row:SetPoint("TOPLEFT", 12, -88 - (i - 1) * 23)
        local font = row:GetFontString()
        font:ClearAllPoints()
        font:SetPoint("TOPLEFT", row, "TOPLEFT", 12, -3)
        font:SetSize(372, 18)
        font:SetWordWrap(false)
        font:SetJustifyH("LEFT")
        row:EnableMouseWheel(true)
        row:SetScript("OnMouseWheel", function(_, delta)
            offset = offset - delta
            ns.UI.RecentErrors.Refresh()
        end)
        rows[i] = row
    end
    explain = button(frame, "Explain → edit unsent question", 250, ns.UI.RecentErrors.Explain)
    explain:SetPoint("TOPLEFT", 12, -158)
    empty = label(frame, "Only after opt-in; empty is not proof no notices occurred.")
    empty:SetPoint("TOPLEFT", 12, -88)
    empty:SetSize(396, 60)
    -- Empty copy is shown only when there are no rows.
    frame:SetScript("OnShow", ns.UI.RecentErrors.Refresh)
    scroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 16, -188)
    scroll:SetSize(366, 42)
    scroll:SetClipsChildren(true)
    editor = CreateFrame("EditBox", "WispAIErrorQuestion", scroll)
    editor:SetMultiLine(true)
    editor:SetAutoFocus(false)
    editor:SetFontObject(ChatFontNormal)
    editor:SetMaxLetters(4000)
    editor:SetPoint("TOPLEFT", scroll, "TOPLEFT")
    editor:SetWidth(366)
    editor:SetHeight(42)
    scroll:SetScrollChild(editor)
    editor:SetScript("OnTextChanged", function()
        scroll:UpdateScrollChildRect()
        ns.UI.RecentErrors.Refresh()
    end)
    editor:SetScript("OnCursorChanged", function(_, _, y, _, height)
        local top = -y
        local current = scroll:GetVerticalScroll()
        if top < current then
            scroll:SetVerticalScroll(top)
        elseif top + height > current + scroll:GetHeight() then
            scroll:SetVerticalScroll(top + height - scroll:GetHeight())
        end
    end)
    -- Enter only edits. Sending requires the distinct button below.
    editor:SetScript("OnEnterPressed", function(self)
        self:Insert("\n")
    end)
    editor:SetScript("OnEscapePressed", function()
        discard()
        frame:Hide()
    end)
    local warning = label(
        frame,
        "Unsent edits stay local. Requested reads share captured notices, not edits. Send shares this question with Wisp. Reads/Send use chat storage/model access.",
        ns.UI.Widgets.MUTED
    )
    warning:SetPoint("TOPLEFT", 12, -236)
    warning:SetSize(396, 40)
    warning:SetFontObject("GameFontNormalSmall")
    send = button(frame, "Send to Wisp", 120, ns.UI.RecentErrors.Send)
    send:SetPoint("BOTTOMRIGHT", -12, 8)
    local cancel = button(frame, "Discard / close", 130, function()
        discard()
        frame:Hide()
    end)
    cancel:SetPoint("BOTTOMLEFT", 12, 8)
    frame:SetScript("OnHide", discard)
    ns.UI.RecentErrors.Refresh()
end
