local _, ns = ...
function ns.Chat.ReceiveSnapshot(data)
    if
        ns.bulkRead
        and type(data) == "table"
        and data.v == ns.VERSION
        and type(data.session) == "string"
        and data.session ~= ""
        and type(data.rev) == "number"
        and data.rev > 0
    then
        ns.bulkRead.session = data.session
    end
    if type(data) ~= "table" or data.v ~= ns.VERSION or data.session ~= ns.session then
        return
    end
    ns.Transport.Acknowledge(data.acks or {})
    if (data.rev or 0) <= ns.rev then
        return
    end
    local applyStarted = ns.Transport.BeginTransportApply and ns.Transport.BeginTransportApply()
    if ns.reusableDownlink and ns.Transport.RememberDownlink then
        ns.Transport.RememberDownlink(data)
    end
    if data.questRevision == 0 then
        -- The bridge restarted or has no usable cache; resend on the next turn.
        ns.questAcknowledged = 0
    end
    if data.characterRevision == 0 then
        ns.characterAcknowledged = 0
    end
    local previous = ns.Chat.Current()
    local previousState = previous and previous.status
    ns.rev, ns.connected, ns.lastSeen = data.rev, data.connected, GetTime()
    ns.bridgeVersion = data.bridgeVersion
    ns.contextPolicy = data.contextPolicy
    ns.modelCatalog = data.modelCatalog or ns.modelCatalog
    if data.capabilities then
        ns.capabilities = data.capabilities.entries
        for id, pending in pairs(ns.capabilityPending) do
            local error = data.capabilities.error
            if (data.capabilities.acks or {})[id] == pending.requestId then
                ns.capabilityPending[id] = nil
            elseif error and error.requestId == pending.requestId then
                ns.capabilityPending[id] = nil
                ns.capabilityError = error.message
            end
        end
        if ns.UI.Capabilities.Refresh then
            ns.UI.Capabilities.Refresh()
        end
    end
    if data.memory and (not ns.memoryPending or data.memory.requestId == ns.memoryPending) then
        ns.memory = data.memory
        ns.memoryPending = nil
        if ns.UI.Memory.Refresh then
            ns.UI.Memory.Refresh()
        end
    end
    if data.panels and ns.Panels.ReceivePanels then
        ns.Panels.ReceivePanels(data.panels, data.panelCommand)
    end
    if data.routines then
        ns.routines = data.routines
    end
    if data.routineRuns then
        ns.routineRuns = data.routineRuns
    end
    if data.routineSubscriptions and ns.Advice.ReceiveRoutineSubscriptions then
        ns.Advice.ReceiveRoutineSubscriptions(data.routineSubscriptions, data.routinesEnabled)
    end
    if data.chats then
        for index = #data.chats, 1, -1 do
            if ns.deletedChats[data.chats[index].id] then
                table.remove(data.chats, index)
            end
        end
        local existing, incoming = {}, {}
        for _, chat in ipairs(ns.chats) do
            existing[chat.id] = chat
        end
        for _, chat in ipairs(data.chats) do
            incoming[chat.id] = chat
            local authoritative = chat.messages ~= nil
            if chat.messages == nil and existing[chat.id] then
                chat.messages = existing[chat.id].messages
            end
            ns.pendingChats[chat.id] = nil
            local confirmed = {}
            for _, message in ipairs(chat.messages or {}) do
                if message.id then
                    confirmed[message.id] = true
                end
            end
            for id, optimistic in pairs(ns.pendingMessages) do
                if optimistic.chat == chat.id then
                    if confirmed[id] then
                        if authoritative then
                            ns.pendingMessages[id] = nil
                        else
                            chat.status = "working"
                        end
                    else
                        chat.messages = chat.messages or {}
                        table.insert(chat.messages, optimistic.message)
                        chat.status = "working"
                        chat.lastActivityAt = math.max(
                            chat.lastActivityAt or 0,
                            (existing[chat.id] and existing[chat.id].lastActivityAt) or 0
                        )
                    end
                end
            end
            if chat.status == "working" then
                ns.workStarted[chat.id] = ns.workStarted[chat.id] or GetTime()
            else
                ns.workStarted[chat.id] = nil
            end
        end
        for id, chat in pairs(ns.pendingChats) do
            if not incoming[id] then
                table.insert(data.chats, chat)
            end
        end
        ns.chats = data.chats
    end
    if data.routineCommand and ns.db.lastRoutineCommand ~= data.routineCommand.seq then
        ns.db.lastRoutineCommand = data.routineCommand.seq
        ns.Chat.Select(data.routineCommand.id)
    end
    if not ns.Chat.Current() then
        ns.active = (
            data.activeChat
            and data.activeChat ~= ""
            and not ns.deletedChats[data.activeChat]
            and data.activeChat
        ) or nil
        if not ns.active then
            for _, chat in ipairs(ns.chats) do
                if not chat.inline then
                    ns.active = chat.id
                    break
                end
            end
        end
        if ns.draft then
            ns.draft:SetText(ns.db.drafts[ns.active] or "")
        end
    end
    ns.db.activeChat = ns.active
    local current = ns.Chat.Current()
    if current and current.status == "done" and previousState == "working" then
        ns.unread = ns.db.minimized
        ns.UI.PlayCompletionSound()
    end
    for _, request in ipairs(data.requests or {}) do
        if not ns.requestsDone[request.id] then
            ns.requestsDone[request.id] = true
            local ok, result = pcall(function()
                if request.action then
                    return ns.Actions.PerformAction and ns.Actions.PerformAction(request.action)
                        or { status = "unavailable", error = "Reload Wisp to enable actions" }
                end
                return request.inspection and ns.Character.Inspect(request.inspection)
                    or ns.Character.Capture(request.sections)
            end)
            if not ok then
                result =
                    { status = "unavailable", error = "Game request failed: " .. tostring(result) }
            end
            ns.Transport.Send({
                type = "state_result",
                chat = request.chat,
                requestId = request.id,
                data = result,
            })
        end
    end
    if data.notifications then
        ns.notifications = data.notifications
        if ns.Advice.RefreshAdvice then
            ns.Advice.RefreshAdvice()
        end
    end
    if ns.UI.Refresh then
        ns.UI.Refresh()
    end
    if ns.Transport.RecordTransportSnapshot then
        ns.Transport.RecordTransportSnapshot(data, applyStarted)
    end
end
