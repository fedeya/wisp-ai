local _, C = ...
local label, setText = C.Widgets.label, C.Widgets.setText
local GOLD, TEXT, MUTED = C.Widgets.GOLD, C.Widgets.TEXT, C.Widgets.MUTED
local mapLocation, macroNameFromLink =
    C.MessageFormat.mapLocation, C.MessageFormat.macroNameFromLink
local formatted, referenceSignature = C.FormatText, C.MessageFormat.signature
C.itemRevision = 0
local function linked(row)
    row:EnableMouse(true)
    row:SetHyperlinksEnabled(true)
    row:SetScript("OnHyperlinkEnter", function(self, link, text)
        C.hoverLink = text or ("|H" .. link .. "|h[Reference]|h")
        GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
        local zone = tonumber(link:match("^wispzone:(%d+)$"))
        if zone then
            local info = C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(zone)
            GameTooltip:SetText(info and info.name or "Map", 1, 0.82, 0)
            GameTooltip:AddLine("Click to open this map.", 0.65, 0.65, 0.65, true)
            GameTooltip:Show()
            return
        end
        local mapId, x, y = mapLocation(link)
        if mapId then
            local info = C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(mapId)
            GameTooltip:SetText(info and info.name or "Map location", 1, 0.82, 0)
            GameTooltip:AddLine(string.format("%.2f, %.2f", x, y), 0.9, 0.87, 0.8)
            GameTooltip:AddLine("Click to view this location on the map.", 0.65, 0.65, 0.65, true)
            GameTooltip:Show()
            return
        end
        local macroName = macroNameFromLink(link)
        if macroName then
            local index = GetMacroIndexByName and GetMacroIndexByName(macroName)
            GameTooltip:SetText(macroName, 1, 0.82, 0)
            if index and index > 0 and GetMacroInfo then
                local _, _, code = GetMacroInfo(index)
                GameTooltip:AddLine((code or ""):gsub("|", "||"), 0.9, 0.87, 0.8, true)
                GameTooltip:AddLine(
                    "Click to pick up this macro, then place it on your action bar.",
                    0.65,
                    0.65,
                    0.65,
                    true
                )
            else
                GameTooltip:AddLine("This macro is no longer available.", 0.8, 0.5, 0.4, true)
            end
            GameTooltip:Show()
            return
        end
        local id = tonumber(link:match("^quest:(%d+)"))
        local quest = id and C.MessageFormat.quest(id)
        if quest then
            GameTooltip:SetText(quest.title, 1, 0.82, 0)
            if quest.level then
                GameTooltip:AddLine("Level " .. quest.level, 0.7, 0.7, 0.7)
            end
            local objectives = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(id)
                or {}
            for _, objective in ipairs(objectives) do
                GameTooltip:AddLine(
                    objective.text or "",
                    objective.finished and 0.4 or 1,
                    objective.finished and 1 or 0.85,
                    0.4,
                    true
                )
            end
            GameTooltip:AddLine("Click to view quest. Shift-click to link.", 0.65, 0.65, 0.65, true)
            GameTooltip:Show()
            return
        end
        if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then
            GameTooltip:Show()
        end
    end)
    row:SetScript("OnHyperlinkLeave", function()
        C.hoverLink = nil
        GameTooltip:Hide()
    end)
    row:SetScript("OnHyperlinkClick", function(self, link, text, mouse)
        if IsShiftKeyDown() then
            C.draft:Insert(text)
            C.draft:SetFocus()
            return
        end
        local zone = tonumber(link:match("^wispzone:(%d+)$"))
        if zone then
            if C_Map and C_Map.OpenWorldMap then
                C_Map.OpenWorldMap(zone)
            else
                C.Log("The map UI is unavailable.")
            end
            return
        end
        local macroName = macroNameFromLink(link)
        if macroName then
            if InCombatLockdown and InCombatLockdown() then
                C.Log("Leave combat before picking up a macro.")
                return
            end
            local index = GetMacroIndexByName and GetMacroIndexByName(macroName)
            if index and index > 0 and PickupMacro then
                PickupMacro(index)
            else
                C.Log("This macro is no longer available.")
            end
            return
        end
        local id = tonumber(link:match("^quest:(%d+)"))
        if id and QuestMapFrame_OpenToQuestDetails then
            QuestMapFrame_OpenToQuestDetails(id)
        else
            SetItemRef(link, text, mouse, self)
        end
    end)
    row:EnableMouseWheel(true)
    row:SetScript("OnMouseWheel", function(_, delta)
        local parent = row
        while parent do
            local target = parent._wispScroll
            if target then
                target:SetVerticalScroll(
                    math.max(
                        0,
                        math.min(
                            target:GetVerticalScrollRange(),
                            target:GetVerticalScroll() - delta * 45
                        )
                    )
                )
                return
            end
            parent = parent:GetParent()
        end
        if C.ScrollTranscript then
            C.ScrollTranscript(delta)
        end
    end)
end
C.LinkWidget = linked
local function makeRow(parent)
    local row = CreateFrame("Frame", nil, parent)
    linked(row)
    row.author = label(row, "", GOLD)
    row.author:SetPoint("TOPLEFT", 0, 0)
    row.text = label(row, "")
    row.text:SetFontObject(ChatFontNormal)
    row.text:SetWordWrap(true)
    row.text:SetSpacing(3)
    row.icon = row:CreateTexture(nil, "ARTWORK")
    row.icon:SetSize(14, 14)
    row.icon:SetPoint("TOPLEFT", 0, -1)
    row.bubble = CreateFrame("Frame", nil, row, "BackdropTemplate")
    row.bubble:SetFrameLevel(row:GetFrameLevel())
    row.bubble:SetAllPoints(row)
    row.bubble:SetBackdrop({
        bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        edgeSize = 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    row.bubble:SetBackdropColor(0.25, 0.19, 0.115, 0.96)
    row.bubble:SetBackdropBorderColor(0.45, 0.35, 0.20, 0.5)
    row.bubble:EnableMouse(false)
    row.bubble:Hide()
    row.disclosure = CreateFrame("Button", nil, row)
    row.disclosure:SetAllPoints(row)
    row.disclosure:SetScript("OnClick", function()
        C.toolGroupsExpanded = C.toolGroupsExpanded or {}
        C.toolGroupsExpanded[row.groupKey] = not C.toolGroupsExpanded[row.groupKey]
        C.Refresh()
        if C.RefreshInline then
            C.RefreshInline()
        end
    end)
    row.disclosure:Hide()
    row.retry = C.Widgets.button(row, "Retry", 80, function(self)
        self:Disable()
        C.Send({
            type = "retry",
            chat = row.retryChat,
            context = C.CaptureTurn and C.CaptureTurn() or C.Capture({ "character", "location" }),
        })
    end)
    row.retry:Hide()
    return row
end
C.MakeMessageRow = makeRow
C.toolGroupsExpanded = {}
function C.DisplayMessages(chat)
    local messages, group = {}, nil
    for index, message in ipairs(chat and chat.messages or {}) do
        if message.role == "tool" then
            if C.db.showTools then
                if not group then
                    group = {
                        id = "tools-" .. (message.id or index),
                        role = "tool",
                        text = "",
                        calls = {},
                    }
                    messages[#messages + 1] = group
                end
                group.calls[#group.calls + 1] = message
            end
        else
            group = nil
            messages[#messages + 1] = message
        end
    end
    for _, message in ipairs(messages) do
        if message.calls then
            local labels, details, running, failed = {}, {}, nil, false
            local extraDetails = {}
            for _, call in ipairs(message.calls) do
                local tool = call.tool or {}
                local name = tool.label or call.text or "Tool"
                labels[#labels + 1] = name
                details[#details + 1] = name .. " - " .. (tool.status or "completed")
                if type(tool.detail) == "string" and tool.detail ~= "" and tool.detail ~= name then
                    extraDetails[#extraDetails + 1] = tool.detail
                    details[#details] = details[#details] .. "\n" .. tool.detail
                end
                if tool.status == "running" then
                    running = name
                end
                if tool.status and tool.status ~= "running" and tool.status ~= "completed" then
                    failed = true
                end
            end
            if #labels > 1 or #extraDetails > 0 then
                message.groupKey = chat.id .. ":" .. message.id
            end
            local expanded = message.groupKey and C.toolGroupsExpanded[message.groupKey]
            local summary = running or table.concat(labels, " / ", 1, math.min(2, #labels))
            if #labels > 2 and not running then
                summary = summary .. " / +" .. (#labels - 2)
            end
            message.text = (message.groupKey and (expanded and "- " or "+ ") or "")
                .. summary
                .. (
                    expanded
                        and ("\n" .. table.concat(#labels == 1 and extraDetails or details, "\n"))
                    or ""
                )
            message.tool = {
                label = message.text,
                status = running and "running" or (failed and "failed" or "completed"),
            }
        end
    end
    return messages
end
function C.PositionMessageRow(row, parent, y, width)
    local x = row.speaker == "user" and width - row:GetWidth() or 0
    if row.y ~= y or row.x ~= x then
        row.y, row.x = y, x
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", parent, "TOPLEFT", x, -y)
    end
end
function C.MessageGap(previous, speaker)
    return previous and previous ~= speaker and 12 or 0
end
function C.ChatSignature(chat)
    local parts = { chat and chat.id or "" }
    for _, message in ipairs(chat and chat.messages or {}) do
        parts[#parts + 1] = (message.id or "")
            .. (message.text or "")
            .. (message.tool and message.tool.status or "")
            .. (C.RichSignature and C.RichSignature({ message.ui, message.parts }) or "")
    end
    return table.concat(parts, "\31")
end
function C.UpdateNewMessages(button, chat, follow, switched)
    local signature = C.ChatSignature(chat)
    if not switched and button.signature and button.signature ~= signature and not follow then
        button.pending = true
    end
    if follow or switched then
        button.pending = false
    end
    button.signature = signature
    button:SetShown(button.pending == true and not follow)
end
function C.MessageSpeaker(message)
    return (message.role == "tool" or message.role == "assistant") and "assistant" or message.role
end
function C.RenderMessageRow(row, chat, message, width, showAuthor)
    local tool = message.tool
    local signature = chat.id
        .. "\31"
        .. (message.role or "")
        .. "\31"
        .. (message.text or "")
        .. "\31"
        .. (tool and tool.status or "")
        .. "\31"
        .. width
        .. "\31"
        .. C.itemRevision
        .. "\31"
        .. referenceSignature(message.references)
        .. "\31"
        .. (C.RichSignature and C.RichSignature({ message.ui, message.parts }) or "")
        .. "\31"
        .. (chat.status or "")
        .. "\31"
        .. tostring(showAuthor)
        .. "\31"
        .. tostring(message.groupKey)
    if row.signature ~= signature then
        row.signature = signature
        row.speaker = message.role
        local padding = message.role == "user" and 8 or 0
        if message.role == "user" then
            width = math.floor(width * 0.84)
        end
        row:SetWidth(width)
        row.bubble:SetShown(message.role == "user")
        row.groupKey = message.groupKey
        row.disclosure:SetShown(message.groupKey ~= nil)
        row.text:Show()
        row.text:ClearAllPoints()
        local top = message.role == "user" and padding or (showAuthor and 20 or 0)
        row.author:ClearAllPoints()
        row.author:SetPoint(
            message.role == "user" and "TOPRIGHT" or "TOPLEFT",
            message.role == "user" and -10 or 0,
            -padding
        )
        row.author:SetShown(showAuthor and message.role ~= "user")
        setText(
            row.author,
            message.role == "user" and "You" or (message.role == "system" and "Notice" or "Wisp AI")
        )
        if message.role == "tool" then
            if row.rich then
                row.rich:Hide()
            end
            row.icon:ClearAllPoints()
            row.icon:SetPoint("TOPLEFT", 0, -top - 1)
            row.icon:Show()
            local state = tool and tool.status or "completed"
            row.icon:SetTexture(
                state == "completed" and "Interface\\RaidFrame\\ReadyCheck-Ready"
                    or (
                        state == "running" and "Interface\\RaidFrame\\ReadyCheck-Waiting"
                        or "Interface\\RaidFrame\\ReadyCheck-NotReady"
                    )
            )
            row.text:SetPoint("TOPLEFT", 21, -top)
            row.text:SetWidth(width - 21)
            row.text:SetTextColor(unpack(MUTED))
            local suffix = state == "running" and "  |cffe0c070Running|r"
                or (state == "completed" and "" or "  |cffd98575Failed|r")
            setText(row.text, formatted(tool and tool.label or message.text) .. suffix)
            row.height = top + math.max(18, row.text:GetStringHeight()) + 7
        else
            row.icon:Hide()
            row.text:SetPoint("TOPLEFT", padding, -top)
            row.text:SetWidth(width - padding * 2)
            row.text:SetTextColor(unpack(message.role == "system" and MUTED or TEXT))
            setText(row.text, formatted(message.text, message.references, message.role == "user"))
            if message.role == "user" and not (message.ui and #message.ui > 0) then
                local natural = row.text.GetUnboundedStringWidth
                    and row.text:GetUnboundedStringWidth()
                if type(natural) == "number" and natural > 0 then
                    width = math.min(width, math.max(64, math.ceil(natural) + padding * 2))
                    row:SetWidth(width)
                    row.text:SetWidth(width - padding * 2)
                end
            end
            local interleaved = message.parts
                and #message.parts > 0
                and message.ui
                and #message.ui > 0
            row.text:SetShown(not interleaved)
            row.height = top
                + math.max(
                    1,
                    not interleaved and message.text ~= "" and row.text:GetStringHeight() or 0
                )
                + (message.role == "user" and padding or 10)
            if C.RenderRichUI then
                if not row.rich then
                    row.rich = CreateFrame("Frame", nil, row)
                    linked(row.rich)
                end
                row.rich:Show()
                row.rich:ClearAllPoints()
                row.rich:SetPoint("TOPLEFT", padding, -(interleaved and top or row.height))
                row.height = row.height
                    + C.RenderRichUI(row.rich, chat, message, width - padding * 2)
            end
            if message.role ~= "user" then
                row.height = row.height + 8
            end
        end
        local retry = chat.status == "error"
            and message.role == "system"
            and message == chat.messages[#chat.messages]
        row.retry:SetShown(retry)
        row.retryChat = chat.id
        if retry then
            row.retry:Enable()
            row.retry:ClearAllPoints()
            row.retry:SetPoint("TOPLEFT", 0, -row.height)
            row.height = row.height + 30
        end
        row:SetHeight(row.height)
    end
end
