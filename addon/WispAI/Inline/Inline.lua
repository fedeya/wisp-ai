local _, ns = ...
local uiWidgets = ns.UI.Widgets
BINDING_HEADER_WISPAI = "Wisp"
BINDING_NAME_WISPAI_INLINE = "Ask about hovered reference"
local panel, entry, title, scroll, content, busy, send
local rows = {}
local newMessages, renderedChat
local replyTurn = {}
local bindingCapture, hotkey, bindingEvents, lastActivation, bindingSignature
local mouseKeys = { LeftButton = "BUTTON1", RightButton = "BUTTON2", MiddleButton = "BUTTON3" }
local function combination(key)
    return (IsControlKeyDown() and "CTRL-" or "")
        .. (IsAltKeyDown() and "ALT-" or "")
        .. (IsShiftKeyDown() and "SHIFT-" or "")
        .. key
end
local function mouseKey(button)
    local number = button:match("^Button(%d+)$")
    return mouseKeys[button] or (number and ("BUTTON" .. number))
end
local function bindingStatus(event, key, error)
    if ns.Transport.Send then
        ns.Transport.Send({
            type = "inline_status",
            data = {
                event = event,
                key = key or (ns.db and ns.db.inlineBinding),
                action = key and GetBindingAction and GetBindingAction(key, true),
                panelShown = panel and panel:IsShown() or false,
                hasReference = panel and panel.reference ~= nil or false,
                error = error and tostring(error):sub(1, 300),
            },
        })
    end
end
function ns.Inline.ActivateInline(key)
    if bindingCapture and bindingCapture:IsShown() then
        return
    end
    local now = GetTime()
    if lastActivation and now - lastActivation < 0.15 then
        return
    end
    lastActivation = now
    local ok, error = pcall(ns.Inline.OpenInline)
    if not ok then
        ns.Core.Log("Inline chat could not open: " .. tostring(error))
    end
    bindingStatus("activated", key, not ok and error or nil)
end
function ns.Inline.RefreshInlineBindings()
    if not hotkey or not SetOverrideBindingClick or not ClearOverrideBindings then
        return
    end
    if InCombatLockdown and InCombatLockdown() then
        return
    end
    if bindingCapture and bindingCapture:IsShown() then
        if bindingSignature ~= "capturing" then
            bindingSignature = "capturing"
            ClearOverrideBindings(hotkey)
        end
        return
    end
    local first, second = GetBindingKey("WISPAI_INLINE")
    local keys = { first or false, second or false, ns.db and ns.db.inlineBinding or false }
    local signature = {}
    for _, key in ipairs(keys) do
        signature[#signature + 1] = tostring(key) .. ":" .. (key and GetBindingAction(key) or "")
    end
    signature = table.concat(signature, ";")
    if signature == bindingSignature then
        return
    end
    bindingSignature = signature
    ClearOverrideBindings(hotkey)
    local seen = {}
    for _, key in ipairs(keys) do
        if key and not seen[key] then
            seen[key] = true
            local action = GetBindingAction(key)
            if
                action == "WISPAI_INLINE" or (action == "" and ns.db and ns.db.inlineBinding == key)
            then
                SetOverrideBindingClick(hotkey, true, key, "WispAIInlineHotkey", "LeftButton")
            end
        end
    end
    if C_Timer and C_Timer.After then
        C_Timer.After(0, function()
            bindingStatus("ready", first or (ns.db and ns.db.inlineBinding))
        end)
    end
end
function ns.Inline.InlineCurrent()
    for _, chat in ipairs(ns.chats or {}) do
        if chat.id == ns.inlineId then
            return chat
        end
    end
end
function ns.Inline.CloseInline()
    if panel and panel:IsShown() then
        entry:ClearFocus()
        panel:Hide()
        return true
    end
    return false
end
function ns.Inline.AskPanel(panelId, node, values)
    if node.action.kind ~= "ask" then
        return
    end
    if not panel then
        ns.Inline.InitInline()
    end
    local current = ns.Inline.InlineCurrent()
    if current and current.status == "working" then
        ns.Core.Log("Wait for the current inline question.")
        return
    end
    ns.inlineCounter = (ns.inlineCounter or 0) + 1
    ns.inlineId = ns.session .. "-panel-question-" .. ns.inlineCounter
    local chat = {
        id = ns.inlineId,
        title = "Panel question",
        inline = true,
        status = "working",
        messages = {},
        activity = {},
    }
    ns.messageCounter = (ns.messageCounter or 0) + 1
    local id = ns.session .. "-message-" .. ns.messageCounter
    local message = { id = id, role = "user", text = node.label or "Panel question" }
    chat.messages[1] = message
    ns.chats[#ns.chats + 1] = chat
    ns.pendingChats[chat.id] = chat
    ns.pendingMessages[id] = { chat = chat.id, message = message }
    ns.workStarted[chat.id] = GetTime()
    panel.reference = nil
    entry:SetText("")
    title:SetText("Ask Wisp · Panel")
    panel:Show()
    scroll:SetVerticalScroll(0)
    ns.Transport.Send({
        type = "panel_ask",
        chat = chat.id,
        messageId = id,
        key = panelId,
        nodeId = node.id,
        values = values,
        context = ns.Character.CaptureTurn and ns.Character.CaptureTurn()
            or ns.Character.Capture({ "character", "location" }),
    })
    ns.Inline.RefreshInline()
    entry:SetFocus()
end
function ns.Inline.CaptureHover()
    if ns.hoverLink then
        return ns.hoverLink
    end
    local tips = { GameTooltip, ItemRefTooltip }
    for _, tip in ipairs(tips) do
        if tip and tip:IsShown() then
            if tip.GetItem then
                local ok, _, link = pcall(tip.GetItem, tip)
                if ok and link then
                    return link
                end
            end
            if tip.GetSpell then
                local ok, name, id = pcall(tip.GetSpell, tip)
                if ok and id then
                    return "|Hspell:" .. id .. "|h[" .. (name or "Spell") .. "]|h"
                end
            end
            if tip._wispLink then
                return tip._wispLink
            end
            if tip.GetUnit then
                local ok, name, unit = pcall(tip.GetUnit, tip)
                if ok and unit and UnitGUID then
                    local guid = UnitGUID(unit)
                    if guid then
                        return "|Hunit:" .. guid .. "|h[" .. (name or "Unit") .. "]|h"
                    end
                end
            end
            if tip.GetTooltipData then
                local ok, data = pcall(tip.GetTooltipData, tip)
                if
                    ok
                    and type(data) == "table"
                    and data.id
                    and Enum
                    and Enum.TooltipDataType
                    and data.type == Enum.TooltipDataType.Quest
                then
                    local name = C_QuestLog
                        and C_QuestLog.GetTitleForQuestID
                        and C_QuestLog.GetTitleForQuestID(data.id)
                    return "|Hquest:" .. data.id .. "|h[" .. (name or "Quest") .. "]|h"
                end
            end
        end
    end
end
local function inputReference(link)
    local id = link:match("wispzone:(%d+)")
    if id then
        return "[Map](map:" .. id .. ")"
    end
    local hex = link:match("wispmacro:([%x]+)")
    if hex then
        return "[Macro](macro:" .. hex .. ")"
    end
    return link
end
function ns.Inline.EnsureInlineChat()
    local chat = ns.Inline.InlineCurrent()
    if not ns.inlineId then
        ns.inlineCounter = (ns.inlineCounter or 0) + 1
        ns.inlineId = ns.session .. "-inline-" .. ns.inlineCounter
        chat = {
            id = ns.inlineId,
            title = "Quick question",
            inline = true,
            status = "idle",
            messages = {},
            activity = {},
        }
        ns.chats[#ns.chats + 1] = chat
        ns.pendingChats[ns.inlineId] = chat
    end
    return chat
end
function ns.Inline.SendInline()
    local text = (entry:GetText() or ""):match("^%s*(.-)%s*$")
    local chat = ns.Inline.InlineCurrent()
    if text == "" or (ns.modelPending and ns.modelPending[ns.inlineId]) then
        return
    end
    if chat and chat.status == "working" then
        ns.Transport.Send({ type = "cancel", chat = chat.id })
        return
    end
    chat = ns.Inline.EnsureInlineChat()
    local reference = panel.reference
    if reference then
        text = text .. "\n\n" .. inputReference(reference)
    end
    ns.messageCounter = (ns.messageCounter or 0) + 1
    local id = ns.session .. "-message-" .. ns.messageCounter
    local message = { id = id, role = "user", text = text }
    ns.pendingMessages[id] = { chat = chat.id, message = message }
    ns.workStarted[chat.id] = GetTime()
    chat.messages[#chat.messages + 1] = message
    chat.status = "working"
    ns.Transport.Send({
        type = "inline_say",
        chat = chat.id,
        messageId = id,
        text = text,
        context = ns.Character.CaptureTurn and ns.Character.CaptureTurn()
            or ns.Character.Capture({ "character", "location" }),
    })
    entry:SetText("")
    ns.Inline.RefreshInline()
end
function ns.Inline.RefreshInline(preserveScrollForChat)
    if not panel or not panel:IsShown() then
        return
    end
    if ns.UI.RefreshModelControls then
        ns.UI.RefreshModelControls()
    end
    local chat = ns.Inline.InlineCurrent()
    local y, used = 0, {}
    local previousSpeaker, previousMessage
    local width = math.max(180, scroll:GetWidth() - 6)
    local previousRange = scroll:GetVerticalScrollRange()
    local offset = scroll:GetVerticalScroll()
    local preserveScroll = chat and preserveScrollForChat == chat.id
    local follow = not preserveScroll and previousRange - offset < 30
    local messages, hasToolActivity, hasReplyContent, turnStart = ns.UI.DisplayMessages(chat)
    local animateTurn = ns.UI.ObserveReplyTurn(replyTurn, chat, messages[turnStart - 1])
    for index, message in ipairs(messages) do
        if message.role ~= "tool" or ns.db.showTools then
            local key = chat.id .. ":" .. (message.id or index)
            local row = rows[key]
            if not row then
                row = ns.UI.MakeMessageRow(content)
                row.rich = CreateFrame("Frame", nil, row)
                rows[key] = row
            end
            used[key] = true
            local speaker = ns.UI.MessageSpeaker(message)
            y = y + ns.UI.MessageGap(previousMessage, message)
            local showAuthor = speaker ~= "assistant" or previousSpeaker ~= speaker
            local animateReply = animateTurn and index >= turnStart and message.phase == "reply"
            if not row:IsShown() then
                row:Show()
            end
            ns.UI.RenderMessageRow(row, chat, message, width, showAuthor, animateReply)
            previousSpeaker, previousMessage = speaker, message
            local h = row.height
            ns.UI.PositionMessageRow(row, content, y, width)
            if ns.Transport.RecordFirstText then
                ns.Transport.RecordFirstText(chat, message, row)
            end
            y = y + h
            row:SetScript("OnMouseWheel", function(_, delta)
                scroll:SetVerticalScroll(
                    math.max(
                        0,
                        math.min(
                            scroll:GetVerticalScrollRange(),
                            scroll:GetVerticalScroll() - delta * 40
                        )
                    )
                )
            end)
        end
    end
    for key, row in pairs(rows) do
        if not used[key] and row:IsShown() then
            row:Hide()
        end
    end
    local working = chat and chat.status == "working"
    local showBusy = working
        and not hasToolActivity
        and not hasReplyContent
        and not ns.UI.Activity.IsSending(chat)
    busy:SetShown(showBusy)
    ns.UI.Activity.SetSpinner(busy, showBusy == true)
    if showBusy then
        local active = "Thinking…"
        for _, call in ipairs(chat.activity or {}) do
            if call.status == "running" then
                active = call.label or call.name or active
                break
            end
        end
        local showAuthor = previousSpeaker ~= "assistant"
        local top = showAuthor and 20 or 0
        if previousSpeaker and showAuthor then
            y = y + 12
        end
        busy.author:SetShown(showAuthor)
        busy.icon:ClearAllPoints()
        busy.icon:SetPoint("TOPLEFT", 0, -top - 1)
        busy.title:ClearAllPoints()
        busy.title:SetPoint("TOPLEFT", 20, -top)
        busy.title:SetPoint("RIGHT", 0, 0)
        uiWidgets.SetText(busy.title, active)
        busy:ClearAllPoints()
        busy:SetPoint("TOPLEFT", 0, -y)
        busy:SetSize(width, top + 23)
        y = y + busy:GetHeight()
    end
    content:SetWidth(width)
    content:SetHeight(math.max(1, y))
    if follow or preserveScroll then
        local bottom = math.max(0, y - scroll:GetHeight())
        scroll:SetVerticalScroll(follow and bottom or math.min(offset, bottom))
    end
    ns.UI.UpdateNewMessages(newMessages, chat, follow, renderedChat ~= (chat and chat.id))
    renderedChat = chat and chat.id
    uiWidgets.SetText(send, working and "Stop" or "Ask")
end
function ns.Inline.OpenInline()
    if bindingCapture and bindingCapture:IsShown() then
        return
    end
    local reference = ns.Inline.CaptureHover()
    if not panel then
        ns.Inline.InitInline()
    end
    if not reference then
        if panel.reference then
            panel:Show()
            entry:SetFocus()
            return
        end
        ns.Core.Log("Hover an item, spell, quest, unit or Wisp reference, then use Ask inline.")
        return
    end
    if panel.reference ~= reference then
        if ns.inlineId then
            ns.pendingChats[ns.inlineId] = nil
            for id, pending in pairs(ns.pendingMessages) do
                if pending.chat == ns.inlineId then
                    ns.pendingMessages[id] = nil
                end
            end
        end
        ns.inlineId = nil
        entry:SetText("")
        panel.reference = reference
        scroll:SetVerticalScroll(0)
    end
    local name = reference:match("|h(.-)|h") or reference:match("%[([^%]]+)%]") or "Reference"
    uiWidgets.SetText(title, "Ask Wisp · " .. name:gsub("[|%c]", ""))
    if GetCursorPosition then
        local x, y = GetCursorPosition()
        local scale = UIParent:GetEffectiveScale()
        panel:ClearAllPoints()
        panel:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", x / scale + 12, y / scale - 12)
    end
    panel:Show()
    ns.Inline.RefreshInline()
    entry:SetFocus()
end
function ns.Inline.InitInline()
    if panel then
        return
    end
    hotkey = CreateFrame("Button", "WispAIInlineHotkey", UIParent)
    hotkey:RegisterForClicks("AnyUp")
    hotkey:SetScript("OnClick", function()
        ns.Inline.ActivateInline()
    end)
    bindingEvents = CreateFrame("Frame")
    bindingEvents:RegisterEvent("UPDATE_BINDINGS")
    bindingEvents:RegisterEvent("PLAYER_REGEN_ENABLED")
    bindingEvents:RegisterEvent("GLOBAL_MOUSE_DOWN")
    bindingEvents:SetScript("OnEvent", function(_, event, button)
        if event == "GLOBAL_MOUSE_DOWN" then
            if bindingCapture and bindingCapture:IsShown() then
                return
            end
            local key = mouseKey(button)
            if key then
                key = combination(key)
                local action = GetBindingAction(key, true)
                if action == "WISPAI_INLINE" or action == "CLICK WispAIInlineHotkey:LeftButton" then
                    ns.Inline.ActivateInline(key)
                end
            end
        else
            ns.Inline.RefreshInlineBindings()
        end
    end)
    panel = CreateFrame("Frame", "WispAIInline", UIParent, "BackdropTemplate")
    panel:SetSize(420, 340)
    panel:SetPoint("CENTER")
    panel:SetFrameStrata("DIALOG")
    panel:SetClampedToScreen(true)
    panel:SetMovable(true)
    panel:EnableMouse(true)
    panel:SetBackdrop({
        bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        tile = true,
        tileSize = 16,
        edgeSize = 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    panel:SetBackdropColor(0.09, 0.075, 0.055, 0.98)
    panel:SetBackdropBorderColor(0.43, 0.38, 0.28, 1)
    title = panel:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    title:SetPoint("TOPLEFT", 12, -12)
    title:SetPoint("RIGHT", -110, 0)
    title:SetJustifyH("LEFT")
    title:SetWordWrap(false)
    local close = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    close:SetSize(24, 22)
    close:SetPoint("TOPRIGHT", -8, -7)
    close:SetText("x")
    close:SetScript("OnClick", function()
        entry:ClearFocus()
        panel:Hide()
    end)
    local expand = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    expand:SetSize(70, 22)
    expand:SetPoint("RIGHT", close, "LEFT", -5, 0)
    expand:SetText("Expand")
    expand:SetScript("OnClick", function()
        local chat = ns.Inline.InlineCurrent()
        if not chat then
            return
        end
        chat.inline = false
        ns.Transport.Send({ type = "promote_inline", chat = chat.id })
        ns.inlineId = nil
        panel:Hide()
        ns.Chat.Select(chat.id)
        ns.UI.SetMinimized(false)
    end)
    panel:RegisterForDrag("LeftButton")
    panel:SetScript("OnDragStart", function()
        panel:StartMoving()
    end)
    panel:SetScript("OnDragStop", function()
        panel:StopMovingOrSizing()
    end)
    if ns.UI.CreateModelControls then
        local picker = ns.UI.CreateModelControls(
            panel,
            "WispAIInlineModelControls",
            ns.Inline.InlineCurrent,
            ns.Inline.EnsureInlineChat
        )
        picker:SetPoint("BOTTOMLEFT", 12, 13)
    end
    scroll = CreateFrame("ScrollFrame", nil, panel, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 12, -42)
    scroll:SetPoint("BOTTOMRIGHT", -30, 81)
    scroll:EnableMouseWheel(true)
    scroll:SetScript("OnMouseWheel", function(_, delta)
        scroll:SetVerticalScroll(
            math.max(
                0,
                math.min(scroll:GetVerticalScrollRange(), scroll:GetVerticalScroll() - delta * 40)
            )
        )
    end)
    content = CreateFrame("Frame", nil, scroll)
    content:SetSize(370, 1)
    content._wispScroll = scroll
    scroll:SetScrollChild(content)
    newMessages = CreateFrame("Button", "WispAIInlineNewMessages", panel, "UIPanelButtonTemplate")
    newMessages:SetSize(140, 24)
    newMessages:SetText("New messages v")
    newMessages:SetPoint("BOTTOM", scroll, "BOTTOM", 0, 8)
    newMessages:SetFrameLevel(scroll:GetFrameLevel() + 10)
    newMessages:SetScript("OnClick", function()
        scroll:SetVerticalScroll(scroll:GetVerticalScrollRange())
        newMessages.pending = false
        newMessages:Hide()
    end)
    scroll:SetScript("OnVerticalScroll", function(_, offset)
        if offset >= scroll:GetVerticalScrollRange() - 30 then
            newMessages.pending = false
            newMessages:Hide()
        end
    end)
    newMessages:Hide()
    busy = CreateFrame("Frame", "WispAIInlineProgress", content)
    busy.icon = busy:CreateTexture(nil, "ARTWORK")
    busy.icon:SetSize(14, 14)
    ns.UI.Activity.SetIcon(busy.icon, 1, uiWidgets.GOLD)
    busy.author = uiWidgets.Label(busy, "Wisp AI", uiWidgets.GOLD)
    busy.author:SetPoint("TOPLEFT", 0, 0)
    busy.title = uiWidgets.Label(busy, "Thinking…", uiWidgets.MUTED)
    busy.title:SetFontObject(ChatFontNormal)
    busy.title:SetWordWrap(false)
    busy:Hide()
    entry = CreateFrame("EditBox", "WispAIInlineInput", panel, "InputBoxTemplate")
    entry:SetAutoFocus(false)
    entry:SetMaxLetters(2000)
    entry:SetHeight(28)
    entry:SetPoint("BOTTOMLEFT", 17, 41)
    entry:SetPoint("BOTTOMRIGHT", -17, 41)
    entry:SetScript("OnEnterPressed", ns.Inline.SendInline)
    entry:SetScript("OnEscapePressed", function()
        entry:ClearFocus()
        panel:Hide()
    end)
    send = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    send:SetSize(65, 27)
    send:SetPoint("BOTTOMRIGHT", -10, 13)
    send:SetText("Ask")
    send:SetScript("OnClick", function()
        local chat = ns.Inline.InlineCurrent()
        if chat and chat.status == "working" then
            ns.Transport.Send({ type = "cancel", chat = chat.id })
        else
            ns.Inline.SendInline()
        end
    end)
    if hooksecurefunc and GameTooltip then
        hooksecurefunc(GameTooltip, "SetHyperlink", function(tip, link)
            if type(link) == "string" then
                local line = tip.GetName and _G[(tip:GetName() or "") .. "TextLeft1"]
                local name = line and line:GetText() or "Reference"
                tip._wispLink = "|H" .. link .. "|h[" .. (name or "Reference") .. "]|h"
            end
        end)
        if GameTooltip.HookScript then
            GameTooltip:HookScript("OnHide", function()
                GameTooltip._wispLink = nil
            end)
        end
    end
    panel:Hide()
    ns.Inline.RefreshInlineBindings()
end
function ns.Inline.BindInline()
    if InCombatLockdown and InCombatLockdown() then
        ns.Core.Log("Leave combat before changing keybindings.")
        return
    end
    if bindingCapture then
        bindingCapture:Hide()
    end
    local capture = CreateFrame("Frame", nil, UIParent)
    bindingCapture = capture
    ns.Inline.RefreshInlineBindings()
    capture:SetAllPoints(UIParent)
    capture:SetFrameStrata("FULLSCREEN_DIALOG")
    capture:EnableMouse(true)
    capture:EnableMouseWheel(true)
    local dialog = CreateFrame("Frame", nil, capture, "BackdropTemplate")
    dialog:SetSize(380, 110)
    dialog:SetPoint("CENTER")
    dialog:SetFrameStrata("FULLSCREEN_DIALOG")
    dialog:EnableKeyboard(true)
    dialog:EnableMouse(true)
    dialog:EnableMouseWheel(true)
    dialog:SetScript("OnHide", function()
        if capture:IsShown() then
            capture:Hide()
        end
        ns.Inline.RefreshInlineBindings()
    end)
    dialog:SetBackdrop({
        bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        edgeSize = 12,
    })
    dialog:SetBackdropColor(0.1, 0.08, 0.05, 1)
    local hint = dialog:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    hint:SetPoint("TOPLEFT", 15, -20)
    hint:SetWidth(350)
    hint:SetWordWrap(true)
    hint:SetText(
        "Press a key, mouse button or mouse wheel for inline chat.\nCtrl, Alt and Shift are supported. Escape cancels. Existing bindings will be preserved."
    )
    local function assign(key)
        if InCombatLockdown and InCombatLockdown() then
            dialog:Hide()
            ns.Core.Log("Binding was not changed in combat.")
            return
        end
        local selectedKey = combination(key)
        local existing = GetBindingAction(selectedKey)
        if existing and existing ~= "" and existing ~= "WISPAI_INLINE" then
            hint:SetText(
                selectedKey
                    .. " is already assigned to "
                    .. existing
                    .. ".\nChoose another combination or press Escape."
            )
            return
        end
        local old1, old2 = GetBindingKey("WISPAI_INLINE")
        if SetBinding(selectedKey, "WISPAI_INLINE") then
            if old1 and old1 ~= selectedKey then
                SetBinding(old1)
            end
            if old2 and old2 ~= selectedKey then
                SetBinding(old2)
            end
            SaveBindings(GetCurrentBindingSet())
            ns.db.inlineBinding = selectedKey
            ns.Core.Log("Inline chat: " .. selectedKey)
            dialog:Hide()
        else
            hint:SetText("This key could not be assigned. Choose another combination.")
        end
    end
    dialog:SetScript("OnKeyDown", function(self, key)
        if self.SetPropagateKeyboardInput then
            self:SetPropagateKeyboardInput(false)
        end
        if key == "ESCAPE" then
            self:Hide()
            return
        end
        if
            key == "LSHIFT"
            or key == "RSHIFT"
            or key == "LCTRL"
            or key == "RCTRL"
            or key == "LALT"
            or key == "RALT"
        then
            return
        end
        assign(key)
    end)
    local function onMouseDown(_, button)
        local key = mouseKey(button)
        if key then
            assign(key)
        end
    end
    local function onMouseWheel(_, delta)
        if delta ~= 0 then
            assign(delta > 0 and "MOUSEWHEELUP" or "MOUSEWHEELDOWN")
        end
    end
    capture:SetScript("OnMouseDown", onMouseDown)
    dialog:SetScript("OnMouseDown", onMouseDown)
    capture:SetScript("OnMouseWheel", onMouseWheel)
    dialog:SetScript("OnMouseWheel", onMouseWheel)
end
