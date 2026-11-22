local _, ns = ...
local L = ns.L
local COLORS = ns.UI.Widgets.COLORS
local box, button = ns.UI.Widgets.Box, ns.UI.Widgets.Button
local transcript, content, scrollBar, newMessages
local rows, scrollPositions = {}, {}
local renderedChat
local replyTurn = {}
local rendering, scrollRange, contentHeight = false, 0, 0
-- A long chat renders only its latest messages, so opening it or resizing the
-- window costs the same however long it is. Reaching the top renders earlier
-- ones in steps. Each chat remembers the first message it renders.
local WINDOW, STEP = 50, 50
local windowStart = {}
local hasEarlier = false

local function firstShown(id, messages, follow)
    local anchor = windowStart[id]
    if anchor then
        for index, message in ipairs(messages) do
            if message.id == anchor then
                -- Following the bottom drops what scrolling up added, once it grows.
                if not follow or #messages - index < WINDOW + STEP then
                    return index
                end
                break
            end
        end
    end
    local index = math.max(1, #messages - WINDOW + 1)
    windowStart[id] = messages[index] and messages[index].id
    return index
end

local function loadEarlier()
    local chat = ns.Chat.Current()
    if not hasEarlier or rendering or not chat or chat.id ~= renderedChat then
        return
    end
    local messages = ns.UI.DisplayMessages(chat)
    local first = firstShown(chat.id, messages, false)
    windowStart[chat.id] = messages[math.max(1, first - STEP)].id
    local height, offset = contentHeight, transcript:GetVerticalScroll()
    ns.UI.Transcript.Refresh(chat, chat.id)
    -- Keep the message that was at the top where it was.
    scrollBar:SetValue(math.min(scrollRange, offset + contentHeight - height))
end

function ns.UI.ScrollTranscript(delta)
    if delta > 0 and scrollBar:GetValue() <= 0 and hasEarlier then
        loadEarlier()
        return
    end
    scrollBar:SetValue(math.max(0, math.min(scrollRange, scrollBar:GetValue() - delta * 45)))
end

-- The composer reports its reserved bottom space; transcript anchors stay here.
function ns.UI.Transcript.SetBottomInset(inset)
    transcript:SetPoint("BOTTOMRIGHT", -31, inset)
    scrollBar:SetPoint("BOTTOMRIGHT", -10, inset)
end

function ns.UI.Transcript.Refresh(chat, preserveScrollForChat)
    rendering = true
    local id = chat and chat.id or "empty"
    local switched = renderedChat ~= id
    local oldOffset = transcript:GetVerticalScroll()
    if switched and renderedChat then
        scrollPositions[renderedChat] =
            { offset = oldOffset, follow = scrollRange - oldOffset < 30 }
    end
    local follow = scrollRange - oldOffset < 30
    if switched then
        local saved = scrollPositions[id]
        oldOffset = saved and saved.offset or 0
        follow = not saved or saved.follow
    end
    if preserveScrollForChat == id then
        follow = false
    end
    local width = math.max(100, transcript:GetWidth() - 6)
    local y, used = 0, {}
    local previousSpeaker, previousMessage
    local messages, hasToolActivity, hasReplyContent, turnStart = ns.UI.DisplayMessages(chat)
    local animateTurn = ns.UI.ObserveReplyTurn(replyTurn, chat, messages[turnStart - 1])
    local first = firstShown(id, messages, follow)
    hasEarlier = first > 1
    for index = first, #messages do
        local message = messages[index]
        if message.role ~= "tool" or ns.db.showTools then
            local key = id .. ":" .. (message.id or tostring(index))
            local row = rows[key]
            if not row then
                row = ns.UI.MakeMessageRow(content)
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
            ns.UI.PositionMessageRow(row, content, y, width)
            if ns.Transport.RecordFirstText then
                ns.Transport.RecordFirstText(chat, message, row)
            end
            y = y + row.height
        end
    end
    local showProgress = chat
        and chat.status == "working"
        and not hasToolActivity
        and not hasReplyContent
        and not ns.UI.Activity.IsSending(chat)
    if showProgress and previousSpeaker and previousSpeaker ~= "assistant" then
        y = y + 12
    end
    y = ns.UI.Activity.LayoutProgress(y, width, previousSpeaker ~= "assistant", showProgress)
    for key, row in pairs(rows) do
        if not used[key] and row:IsShown() then
            row:Hide()
        end
    end
    content:SetWidth(width)
    content:SetHeight(math.max(1, y))
    contentHeight = y
    scrollRange = math.max(0, y - transcript:GetHeight())
    scrollBar:SetMinMaxValues(0, math.max(1, scrollRange))
    scrollBar:EnableMouse(scrollRange > 0)
    -- The bar keeps its space but only shows when there is something to scroll.
    scrollBar:SetAlpha(scrollRange > 0 and 1 or 0)
    local position = follow and scrollRange or math.min(oldOffset, scrollRange)
    scrollBar:SetValue(position)
    ns.UI.Widgets.SetScroll(transcript, position)
    ns.UI.UpdateNewMessages(newMessages, chat, follow, switched)
    renderedChat = id
    rendering = false
end

function ns.UI.Transcript.Build(chatPanel, header)
    transcript = CreateFrame("ScrollFrame", nil, chatPanel)
    transcript:SetPoint("TOPLEFT", 16, -14)
    transcript:SetPoint("BOTTOMRIGHT", -31, 104)
    content = CreateFrame("Frame", nil, transcript)
    content:SetSize(360, 1)
    transcript:SetScrollChild(content)
    scrollBar = CreateFrame("Slider", "WispAITranscriptScrollBar", chatPanel, "BackdropTemplate")
    scrollBar:SetOrientation("VERTICAL")
    scrollBar:SetPoint("TOPRIGHT", -10, -14)
    scrollBar:SetPoint("BOTTOMRIGHT", -10, 104)
    scrollBar:SetWidth(14)
    box(scrollBar, COLORS.window, COLORS.window)
    scrollBar:SetMinMaxValues(0, 1)
    scrollBar:SetValueStep(1)
    if scrollBar.SetObeyStepOnDrag then
        scrollBar:SetObeyStepOnDrag(false)
    end
    scrollBar:SetThumbTexture("Interface\\Buttons\\WHITE8X8")
    scrollBar:GetThumbTexture():SetSize(4, 28)
    scrollBar:GetThumbTexture():SetVertexColor(unpack(COLORS.lineStrong))
    scrollBar:SetScript("OnValueChanged", function(_, value)
        ns.UI.Widgets.SetScroll(transcript, value)
        if not rendering and newMessages and value >= scrollRange - 30 then
            newMessages.pending = false
            newMessages:Hide()
        end
        if not rendering and value <= 0 and hasEarlier then
            loadEarlier()
        end
    end)
    newMessages = button(chatPanel, L["transcript.newMessages"], 140, function()
        scrollBar:SetValue(scrollRange)
        newMessages.pending = false
        newMessages:Hide()
    end)
    newMessages:SetPoint("BOTTOM", transcript, "BOTTOM", 0, 8)
    newMessages:SetFrameLevel(transcript:GetFrameLevel() + 10)
    newMessages:Hide()
    transcript:EnableMouseWheel(true)
    transcript:SetScript("OnMouseWheel", function(_, delta)
        ns.UI.ScrollTranscript(delta)
    end)
    ns.UI.Activity.Build(header, transcript, content)
end
