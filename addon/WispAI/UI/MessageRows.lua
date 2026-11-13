local _, ns = ...
local label, setText = ns.UI.Widgets.Label, ns.UI.Widgets.SetText
local GOLD, TEXT, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.TEXT, ns.UI.Widgets.MUTED
local mapLocation, macroNameFromLink =
    ns.UI.MessageFormat.MapLocation, ns.UI.MessageFormat.MacroNameFromLink
local formatted = ns.UI.FormatText
local writer = ns.UI.Writing
local CHEVRON_GAP = 4
local DELIVERY_HEIGHT = 20
local DELIVERY_DELAY = 15
local TOOL_STATES = {
    completed = { cell = 0, tint = MUTED },
    running = { cell = 1, tint = GOLD },
    failed = { cell = 2, tint = { 0.85, 0.52, 0.46 } },
}
local toolGroupsExpanded = {}

ns.itemRevision = 0
local function linked(row)
    row:EnableMouse(true)
    row:SetHyperlinksEnabled(true)
    row:SetScript("OnHyperlinkEnter", function(self, link, text)
        ns.hoverLink = text or ("|H" .. link .. "|h[Reference]|h")
        GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
        local url = ns.Markdown.Links.Decode(link)
        if url then
            GameTooltip:SetText(url, 0.5, 0.78, 0.94)
            GameTooltip:AddLine("Click to copy this web address.", 0.65, 0.65, 0.65, true)
            GameTooltip:Show()
            return
        end
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
        local quest = id and ns.UI.MessageFormat.Quest(id)
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
        ns.hoverLink = nil
        GameTooltip:Hide()
    end)
    row:SetScript("OnHyperlinkClick", function(self, link, text, mouse)
        local url = ns.Markdown.Links.Decode(link)
        if url then
            ns.UI.Widgets.ShowCopyUrl(url)
            return
        end
        if IsShiftKeyDown() then
            ns.draft:Insert(text)
            ns.draft:SetFocus()
            return
        end
        local zone = tonumber(link:match("^wispzone:(%d+)$"))
        if zone then
            if C_Map and C_Map.OpenWorldMap then
                C_Map.OpenWorldMap(zone)
            else
                ns.Core.Log("The map UI is unavailable.")
            end
            return
        end
        local macroName = macroNameFromLink(link)
        if macroName then
            if InCombatLockdown and InCombatLockdown() then
                ns.Core.Log("Leave combat before picking up a macro.")
                return
            end
            local index = GetMacroIndexByName and GetMacroIndexByName(macroName)
            if index and index > 0 and PickupMacro then
                PickupMacro(index)
            else
                ns.Core.Log("This macro is no longer available.")
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
        if ns.UI.ScrollTranscript then
            ns.UI.ScrollTranscript(delta)
        end
    end)
end
ns.UI.LinkWidget = linked

local function updateDelivery(delivery)
    local elapsed = GetTime() - delivery.startedAt
    for index, dot in ipairs(delivery.dots) do
        dot:SetAlpha(0.35 + 0.65 * (0.5 + 0.5 * math.sin(elapsed * 5 - (index - 1) * 0.8)))
    end
    local delayed = elapsed >= DELIVERY_DELAY
    if delivery.waiting:IsShown() ~= delayed then
        delivery.waiting:SetShown(delayed)
    end
end

local function makeDelivery(row)
    local delivery = CreateFrame("Frame", nil, row)
    delivery:SetSize(140, DELIVERY_HEIGHT)
    delivery:SetPoint("TOPRIGHT", row.bubble, "BOTTOMRIGHT", -8, 0)
    delivery.dots = {}
    for index = 1, 3 do
        local dot = label(delivery, ".", GOLD)
        dot:SetFontObject("GameFontNormalLarge")
        dot:SetPoint("RIGHT", delivery, "RIGHT", (index - 3) * 8, 4)
        delivery.dots[index] = dot
    end
    delivery.waiting = label(delivery, "Waiting for bridge", MUTED)
    delivery.waiting:SetFontObject("GameFontHighlightSmall")
    delivery.waiting:SetTextColor(unpack(MUTED))
    delivery.waiting:SetPoint("RIGHT", delivery, "RIGHT", -30, 0)
    delivery.waiting:Hide()
    delivery:SetScript("OnUpdate", updateDelivery)
    return delivery
end

local function makeRow(parent)
    local row = CreateFrame("Frame", nil, parent)
    linked(row)
    row:SetScript("OnHide", writer.Finish)
    row.author = label(row, "", GOLD)
    row.author:SetPoint("TOPLEFT", 0, 0)
    row.text = label(row, "")
    row.text:SetFontObject(ChatFontNormal)
    row.text:SetWordWrap(true)
    row.text:SetSpacing(3)
    row.icon = row:CreateTexture(nil, "ARTWORK")
    row.icon:SetSize(14, 14)
    row.icon:SetPoint("TOPLEFT", 0, -1)
    row.chevron = row:CreateTexture(nil, "ARTWORK")
    row.chevron:SetSize(14, 14)
    row.chevron:Hide()
    row.bubble = CreateFrame("Frame", nil, row, "BackdropTemplate")
    row.bubble:SetFrameLevel(row:GetFrameLevel())
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
    row.disclosure:SetScript("OnClick", function()
        toolGroupsExpanded[row.groupKey] = not toolGroupsExpanded[row.groupKey] or nil
        ns.UI.Refresh(row.chatId)
    end)
    row.disclosure:Hide()
    row.retry = ns.UI.Widgets.Button(row, "Retry", 80, function(self)
        self:Disable()
        ns.Transport.Send({
            type = "retry",
            chat = row.retryChat,
            context = ns.Character.CaptureTurn and ns.Character.CaptureTurn()
                or ns.Character.Capture({ "character", "location" }),
        })
    end)
    row.retry:Hide()
    return row
end
ns.UI.MakeMessageRow = makeRow

local function toolDetails(tool, name)
    local lines = {}
    if type(tool.inputPreview) == "string" and tool.inputPreview ~= "" then
        lines[#lines + 1] = "Input  " .. tool.inputPreview
    end
    if type(tool.resultPreview) == "string" and tool.resultPreview ~= "" then
        lines[#lines + 1] = "Result  " .. tool.resultPreview
    elseif type(tool.detail) == "string" and tool.detail ~= "" and tool.detail ~= name then
        lines[#lines + 1] = tool.detail
    end
    return #lines > 0 and table.concat(lines, "\n\n") or nil
end

local function toolCallRow(chatId, call, id, callId, indent)
    local tool = call.tool or {}
    local name = tool.label or call.text or "Tool"
    local detail = toolDetails(tool, name)
    local key = detail and (chatId .. ":" .. callId)
    local expanded = key and toolGroupsExpanded[key]
    return {
        id = id,
        role = "tool",
        text = name,
        tool = { status = tool.status or "completed" },
        toolIndent = indent,
        groupKey = key,
        groupExpanded = expanded,
        toolDetail = expanded and detail or nil,
    }
end

local function appendToolGroup(messages, chatId, calls, id, loading)
    if #calls == 1 then
        local call = calls[1]
        messages[#messages + 1] = toolCallRow(chatId, call, id, id .. "-call-" .. (call.id or 1), 0)
        return
    end
    local running, failed, latest
    for _, call in ipairs(calls) do
        local tool = call.tool or {}
        latest = tool.label or call.text or "Tool"
        local status = tool.status or "completed"
        if status == "running" then
            running = latest
        elseif status ~= "completed" then
            failed = true
        end
    end
    local key = chatId .. ":" .. id
    local expanded = toolGroupsExpanded[key]
    messages[#messages + 1] = {
        id = id,
        role = "tool",
        text = running
            or (
                expanded and not loading and (#calls .. " tool calls")
                or (latest .. "  +" .. (#calls - 1))
            ),
        tool = { status = running and "running" or (failed and "failed" or "completed") },
        groupKey = key,
        groupExpanded = expanded,
    }
    if expanded then
        for index, call in ipairs(calls) do
            local callId = id .. "-call-" .. (call.id or index)
            messages[#messages + 1] = toolCallRow(chatId, call, callId, callId, 18)
        end
    end
end

local function isTextReply(message)
    return message.role == "assistant" and (message.text or ""):find("%S") ~= nil
end

function ns.UI.DisplayMessages(chat)
    local messages, calls, groupId = {}, {}, nil
    local hasReplyContent, turnStart = false, 1
    local lastTool, hasRunningTool
    local function flushTools(loading)
        if not groupId then
            return
        end
        local header = #messages + 1
        appendToolGroup(messages, chat.id, calls, groupId, loading)
        messages[header].turnLoading = loading
        calls, groupId = {}, nil
    end
    for index, message in ipairs(chat and chat.messages or {}) do
        if message.role == "tool" then
            -- A new call resumes activity even if Wisp has already sent a preamble.
            hasReplyContent = false
            lastTool = message.id or index
            hasRunningTool = hasRunningTool or (message.tool and message.tool.status == "running")
            if ns.db.showTools then
                groupId = groupId or ("tools-" .. (message.id or index))
                calls[#calls + 1] = message
            end
        elseif
            message.role ~= "assistant"
            or isTextReply(message)
            or (message.ui and #message.ui > 0)
        then
            -- Visible replies close the preceding batch at its position in the transcript.
            flushTools(false)
            lastTool, hasRunningTool = nil, nil
            if message.role == "user" or message.role == "system" then
                hasReplyContent = false
                turnStart = #messages + 2
            elseif message.role == "assistant" then
                hasReplyContent = true
            end
            messages[#messages + 1] = message
        end
    end
    local hasToolActivity = groupId ~= nil and hasRunningTool
    flushTools(hasToolActivity and chat.status == "working")
    return messages, hasToolActivity, hasReplyContent, turnStart, not hasRunningTool and lastTool
end

-- An observed chat can receive the new question and its complete reply together.
function ns.UI.ObserveReplyTurn(view, chat, boundary)
    local id = chat and chat.id
    local userId = boundary and boundary.role == "user" and boundary.id
    local working = chat and chat.status == "working"
    local live = working
        or (
            chat
            and chat.status == "done"
            and view.chatId == id
            and (view.working or (view.loaded and userId and view.userId ~= userId))
        )
    view.chatId, view.working, view.userId = id, working, userId
    view.loaded = chat and chat.messages ~= nil
    return live
end

function ns.UI.PositionMessageRow(row, parent, y, width)
    local x = row.speaker == "user" and width - row:GetWidth() or 0
    if row.y ~= y or row.x ~= x then
        row.y, row.x = y, x
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", parent, "TOPLEFT", x, -y)
    end
end
function ns.UI.MessageGap(previous, message)
    if previous and previous.role == "tool" and isTextReply(message) then
        return 6
    end
    return previous and ns.UI.MessageSpeaker(previous) ~= ns.UI.MessageSpeaker(message) and 12 or 0
end
function ns.UI.ChatSignature(chat)
    local parts = { chat and chat.id or "" }
    for _, message in ipairs(chat and chat.messages or {}) do
        parts[#parts + 1] = (message.id or "")
            .. (message.text or "")
            .. (message.tool and message.tool.status or "")
            .. (message.tool and message.tool.resultPreview or "")
            .. (ns.UI.RichSignature and ns.UI.RichSignature({ message.ui, message.parts }) or "")
    end
    return table.concat(parts, "\31")
end
function ns.UI.UpdateNewMessages(button, chat, follow, switched)
    local signature = ns.UI.ChatSignature(chat)
    if not switched and button.signature and button.signature ~= signature and not follow then
        button.pending = true
    end
    if follow or switched then
        button.pending = false
    end
    button.signature = signature
    button:SetShown(button.pending == true and not follow)
end
function ns.UI.MessageSpeaker(message)
    return (message.role == "tool" or message.role == "assistant") and "assistant" or message.role
end
function ns.UI.RenderMessageRow(row, chat, message, width, showAuthor, animateReply)
    row.replyView = row.replyView or ns.Markdown.ReplyView.New()
    local sameReply = row.replyView.chatId == chat.id and row.replyView.messageId == message.id
    local display, viewKey = ns.Markdown.ReplyView.Update(row.replyView, chat.id, message)
    message = display
    local tool = message.tool
    local pendingMessage = message.role == "user"
        and message.id
        and ns.pendingMessages
        and ns.pendingMessages[message.id]
    local sending = chat.status == "working"
        and pendingMessage
        and pendingMessage.chat == chat.id
        and not pendingMessage.acknowledged
    local signature = chat.id
        .. "\31"
        .. (message.id or "")
        .. "\31"
        .. viewKey
        .. "\31"
        .. (tool and tool.status or "")
        .. "\31"
        .. width
        .. "\31"
        .. (chat.status or "")
        .. "\31"
        .. tostring(showAuthor)
        .. "\31"
        .. tostring(message.groupKey)
        .. "\31"
        .. (message.groupExpanded and "1" or "0")
        .. "\31"
        .. (message.toolIndent or 0)
        .. "\31"
        .. (message.toolDetail or "")
        .. "\31"
        .. tostring(message.turnLoading)
        .. "\31"
        .. (sending and "sending" or "")
    if row.signature ~= signature then
        row.signature = signature
        local writing =
            writer.BeginLayout(row, sameReply, message, chat.status == "working", animateReply)
        local writingUnits
        local pending = false
        row.chatId = chat.id
        row.speaker = message.role
        local padding = message.role == "user" and 8 or 0
        if message.role == "user" then
            width = math.floor(width * 0.84)
        end
        row:SetWidth(width)
        row.bubble:SetShown(message.role == "user")
        if message.role == "user" then
            row.bubble:ClearAllPoints()
            row.bubble:SetPoint("TOPLEFT", row, "TOPLEFT", 0, 0)
            row.bubble:SetPoint(
                "BOTTOMRIGHT",
                row,
                "BOTTOMRIGHT",
                0,
                sending and DELIVERY_HEIGHT or 0
            )
        end
        row.groupKey = message.groupKey
        row.disclosure:SetShown(message.groupKey ~= nil)
        row.chevron:SetShown(message.groupKey ~= nil)
        if row.toolDetail then
            row.toolDetail:Hide()
            row.toolDetailBackground:Hide()
        end
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
            local indent = message.toolIndent or 0
            row.icon:ClearAllPoints()
            row.icon:SetPoint("TOPLEFT", indent, -top - 1)
            local state = tool and tool.status or "completed"
            local loading = message.turnLoading
                or (indent > 0 and state == "running" and chat.status == "working")
            row.icon:SetShown(not loading)
            if not loading then
                local icon = TOOL_STATES[state] or TOOL_STATES.failed
                ns.UI.Activity.SetIcon(row.icon, icon.cell, icon.tint)
            end
            local textLeft = indent + (loading and 0 or 20)
            local chevronSpace = row.groupKey and (row.chevron:GetWidth() + CHEVRON_GAP) or 0
            local textWidth = math.max(1, width - textLeft - chevronSpace)
            row.text:SetPoint("TOPLEFT", textLeft, -top)
            row.text:SetWidth(textWidth)
            row.text:SetTextColor(unpack(loading and MUTED or TEXT))
            ns.UI.Activity.SetLoadingText(
                row,
                row.text,
                ns.Markdown.InlineRenderer.Literal(tool and tool.label or message.text),
                loading
            )
            local headerHeight = math.max(18, row.text:GetStringHeight())
            local labelWidth = row.text.GetUnboundedStringWidth
                    and row.text:GetUnboundedStringWidth()
                or row.text:GetStringWidth()
            local labelRight = textLeft + math.min(textWidth, math.ceil(labelWidth))
            if row.groupKey then
                local chevronLeft = labelRight + CHEVRON_GAP
                row.chevron:ClearAllPoints()
                row.chevron:SetPoint("TOPLEFT", row, "TOPLEFT", chevronLeft, -top - 1)
                ns.UI.Activity.SetIcon(row.chevron, message.groupExpanded and 4 or 3, MUTED)
                row.disclosure:ClearAllPoints()
                row.disclosure:SetPoint("TOPLEFT", row, "TOPLEFT", indent, -top)
                row.disclosure:SetPoint("BOTTOMRIGHT", row, "TOPRIGHT", 0, -top - headerHeight)
            end
            row.height = top + headerHeight + 5
            if message.toolDetail then
                if not row.toolDetail then
                    row.toolDetailBackground = row:CreateTexture(nil, "BACKGROUND")
                    row.toolDetailBackground:SetColorTexture(0.84, 0.72, 0.43, 0.08)
                    row.toolDetail = label(row, "", MUTED)
                    row.toolDetail:SetWordWrap(true)
                    row.toolDetail:SetNonSpaceWrap(true)
                    row.toolDetail:SetSpacing(2)
                end
                row.toolDetail:ClearAllPoints()
                row.toolDetail:SetPoint("TOPLEFT", textLeft + 8, -row.height - 6)
                row.toolDetail:SetWidth(width - textLeft - 16)
                setText(row.toolDetail, ns.Markdown.InlineRenderer.Literal(message.toolDetail))
                row.toolDetail:Show()
                row.toolDetailBackground:ClearAllPoints()
                row.toolDetailBackground:SetPoint("TOPLEFT", row.toolDetail, "TOPLEFT", -8, 6)
                row.toolDetailBackground:SetPoint(
                    "BOTTOMRIGHT",
                    row.toolDetail,
                    "BOTTOMRIGHT",
                    8,
                    -6
                )
                row.toolDetailBackground:Show()
                row.height = row.height + row.toolDetail:GetStringHeight() + 18
            end
        else
            row.icon:Hide()
            ns.UI.Activity.SetLoadingText(row)
            local interleaved = message.parts
                and #message.parts > 0
                and not message._markdownSimple
                and (message._markdown or (message.ui and #message.ui > 0))
            row.text:SetPoint("TOPLEFT", padding, -top)
            row.text:SetWidth(width - padding * 2)
            row.text:SetTextColor(unpack(message.role == "system" and MUTED or TEXT))
            local text
            if interleaved then
                text = ""
            elseif message._markdownSimple then
                text = message.parts[1].text
            else
                text, pending = formatted(message.text, message.references, message.role == "user")
            end
            setText(row.text, text)
            if message.role == "user" and not (message.ui and #message.ui > 0) then
                local natural = row.text.GetUnboundedStringWidth
                    and row.text:GetUnboundedStringWidth()
                if type(natural) == "number" and natural > 0 then
                    width = math.min(width, math.max(64, math.ceil(natural) + padding * 2))
                    row:SetWidth(width)
                    row.text:SetWidth(width - padding * 2)
                end
            end
            row.text:SetShown(not interleaved)
            writingUnits = writing and not interleaved and { { fonts = { row.text } } } or nil
            row.height = top
                + math.max(
                    1,
                    not interleaved and message.text ~= "" and row.text:GetStringHeight() or 0
                )
                + (message.role == "user" and padding or 10)
            if ns.UI.RenderRichUI then
                if not row.rich then
                    row.rich = CreateFrame("Frame", nil, row)
                    linked(row.rich)
                end
                if not sameReply or not row.rich.presentedRoots then
                    row.rich.presentedRoots = {}
                end
                row.rich:Show()
                row.rich:ClearAllPoints()
                row.rich:SetPoint("TOPLEFT", padding, -(interleaved and top or row.height))
                local height, waiting, units = ns.UI.RenderRichUI(
                    row.rich,
                    chat,
                    message,
                    width - padding * 2,
                    writing ~= nil,
                    message.role == "assistant" and animateReply
                )
                if interleaved then
                    writingUnits = units
                end
                row.height = row.height + height
                pending = pending or waiting == true
            end
            if message.role ~= "user" then
                row.height = row.height + 8
            end
        end
        ns.Markdown.ReplyView.Rendered(row.replyView, pending)
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
        if sending then
            row.delivery = row.delivery or makeDelivery(row)
            row.delivery.startedAt = ns.workStarted[chat.id] or GetTime()
            updateDelivery(row.delivery)
            row.height = row.height + DELIVERY_HEIGHT
        end
        if row.delivery then
            row.delivery:SetShown(sending == true)
        end
        row:SetHeight(row.height)
        if writing then
            writer.Reveal(row, writingUnits, writing)
        end
    end
end
