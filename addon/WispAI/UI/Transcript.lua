local _, ns = ...
local box, button = ns.UI.Widgets.Box, ns.UI.Widgets.Button
local transcript, content, scrollBar, newMessages
local rows, scrollPositions = {}, {}
local renderedChat
local rendering, scrollRange = false, 0

function ns.UI.ScrollTranscript(delta)
    scrollBar:SetValue(math.max(0, math.min(scrollRange, scrollBar:GetValue() - delta * 45)))
end

-- The composer reports its reserved bottom space; transcript anchors stay here.
function ns.UI.Transcript.SetBottomInset(inset)
    transcript:SetPoint("BOTTOMRIGHT", -31, inset)
    scrollBar:SetPoint("BOTTOMRIGHT", -10, inset)
end

function ns.UI.Transcript.Refresh(chat)
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
    local width = math.max(100, transcript:GetWidth() - 6)
    local y, used = 0, {}
    local previousSpeaker
    local messages, activeTool, hasReplyText = ns.UI.DisplayMessages(chat)
    for index, message in ipairs(messages) do
        if message.role ~= "tool" or ns.db.showTools then
            local key = id .. ":" .. (message.id or tostring(index))
            local row = rows[key]
            if not row then
                row = ns.UI.MakeMessageRow(content)
                rows[key] = row
            end
            used[key] = true
            local speaker = ns.UI.MessageSpeaker(message)
            y = y + ns.UI.MessageGap(previousSpeaker, speaker)
            local showAuthor = speaker ~= "assistant" or previousSpeaker ~= speaker
            ns.UI.RenderMessageRow(row, chat, message, width, showAuthor)
            previousSpeaker = speaker
            ns.UI.PositionMessageRow(row, content, y, width)
            if not row:IsShown() then
                row:Show()
            end
            if ns.Transport.RecordFirstText then
                ns.Transport.RecordFirstText(chat, message, row)
            end
            y = y + row.height
        end
    end
    local showProgress = chat
        and chat.status == "working"
        and not activeTool
        and not hasReplyText
        and not ns.UI.Activity.IsSending(chat)
    y = ns.UI.Activity.LayoutProgress(y, width, previousSpeaker ~= "assistant", showProgress)
    for key, row in pairs(rows) do
        if not used[key] and row:IsShown() then
            row:Hide()
        end
    end
    content:SetWidth(width)
    content:SetHeight(math.max(1, y))
    scrollRange = math.max(0, y - transcript:GetHeight())
    scrollBar:SetMinMaxValues(0, math.max(1, scrollRange))
    scrollBar:EnableMouse(scrollRange > 0)
    scrollBar:SetAlpha(scrollRange > 0 and 1 or 0.35)
    local position = follow and scrollRange or math.min(oldOffset, scrollRange)
    scrollBar:SetValue(position)
    transcript:SetVerticalScroll(position)
    ns.UI.UpdateNewMessages(newMessages, chat, follow, switched)
    renderedChat = id
    rendering = false
end

function ns.UI.Transcript.Build(chatPanel, header)
    transcript = CreateFrame("ScrollFrame", nil, chatPanel)
    transcript:SetPoint("TOPLEFT", 13, -34)
    transcript:SetPoint("BOTTOMRIGHT", -31, 104)
    content = CreateFrame("Frame", nil, transcript)
    content:SetSize(360, 1)
    transcript:SetScrollChild(content)
    scrollBar = CreateFrame("Slider", "WispAITranscriptScrollBar", chatPanel, "BackdropTemplate")
    scrollBar:SetOrientation("VERTICAL")
    scrollBar:SetPoint("TOPRIGHT", -10, -34)
    scrollBar:SetPoint("BOTTOMRIGHT", -10, 104)
    scrollBar:SetWidth(14)
    box(scrollBar, { 0.08, 0.07, 0.05, 1 }, 8)
    scrollBar:SetMinMaxValues(0, 1)
    scrollBar:SetValueStep(1)
    if scrollBar.SetObeyStepOnDrag then
        scrollBar:SetObeyStepOnDrag(false)
    end
    scrollBar:SetThumbTexture("Interface\\Buttons\\UI-ScrollBar-Knob")
    scrollBar:GetThumbTexture():SetSize(14, 28)
    scrollBar:SetScript("OnValueChanged", function(_, value)
        transcript:SetVerticalScroll(value)
        if not rendering and newMessages and value >= scrollRange - 30 then
            newMessages.pending = false
            newMessages:Hide()
        end
    end)
    newMessages = button(chatPanel, "New messages v", 140, function()
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
