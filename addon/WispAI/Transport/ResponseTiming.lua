local _, ns = ...
function ns.Transport.BeginResponseTiming(chat, messageId, startedAt)
    ns.responseTiming[chat] = { messageId = messageId, startedAt = startedAt }
end
function ns.Transport.RecordFirstText(chat, message, row)
    local timing = chat and ns.responseTiming[chat.id]
    if
        not timing
        or timing.recorded
        or timing.pending
        or message.role ~= "assistant"
        or not (message.text or ""):match("%S")
    then
        return
    end
    local userIndex, responseIndex
    for index, entry in ipairs(chat.messages or {}) do
        if entry.role == "user" then
            userIndex = index
        end
        if entry == message then
            responseIndex = index
        end
    end
    if
        not userIndex
        or not responseIndex
        or responseIndex <= userIndex
        or chat.messages[userIndex].id ~= timing.messageId
    then
        return
    end
    timing.pending = true
    timing.hasText = true
    -- Measure a displayed row on the next UI frame, not just receipt of data.
    C_Timer.After(0, function()
        timing.pending = nil
        if
            ns.responseTiming[chat.id] ~= timing
            or timing.recorded
            or not row:IsShown()
            or (row.IsVisible and not row:IsVisible())
        then
            return
        end
        timing.recorded = true
        ns.Transport.Send({
            type = "inline_status",
            chat = chat.id,
            data = {
                event = "first_text",
                messageId = timing.messageId,
                totalMs = math.floor((GetTime() - timing.startedAt) * 1000),
                afterSendingMs = timing.acknowledgedAt
                    and math.floor((GetTime() - timing.acknowledgedAt) * 1000),
            },
        })
    end)
end
