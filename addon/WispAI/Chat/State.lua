local _, ns = ...
local function activityTime()
    local latest = time() * 1000
    for _, chat in ipairs(ns.chats) do
        latest = math.max(latest, (chat.lastActivityAt or 0) + 1)
    end
    return latest
end
local function discardEmptyDraft()
    local chat = ns.Chat.Current()
    if
        chat
        and chat.title == "New conversation"
        and chat.status == "idle"
        and #(chat.messages or {}) == 0
        and #(chat.activity or {}) == 0
        and not chat.routineId
        and not chat.inline
        and not chat.proactive
    then
        ns.Chat.DeleteChat(chat.id)
    end
end
function ns.Chat.NewChat()
    discardEmptyDraft()
    ns.chatCounter = (ns.chatCounter or 0) + 1
    ns.active = ns.session .. "-chat-" .. ns.chatCounter
    ns.db.activeChat = ns.active
    ns.sidebarTab = "chats"
    ns.chats[#ns.chats + 1] = {
        id = ns.active,
        title = "New conversation",
        messages = {},
        activity = {},
        status = "idle",
        lastActivityAt = activityTime(),
    }
    ns.pendingChats[ns.active] = ns.chats[#ns.chats]
    ns.Transport.Send({ type = "new", chat = ns.active })
    if ns.UI.Refresh then
        ns.UI.Refresh()
    end
end
function ns.Chat.Current()
    for _, chat in ipairs(ns.chats) do
        if chat.id == ns.active then
            return chat
        end
    end
end
function ns.Chat.Select(id)
    if ns.draft and ns.active then
        ns.db.drafts[ns.active] = ns.draft:GetText()
    end
    if id ~= ns.active then
        discardEmptyDraft()
    end
    ns.active = id
    for _, chat in ipairs(ns.chats) do
        if chat.id == id then
            ns.sidebarTab = chat.routineId and "routines" or "chats"
            ns.sidebarRoutine = chat.routineId
        end
    end
    ns.db.activeChat = id
    if ns.draft then
        ns.draft:SetText(ns.db.drafts[id] or "")
    end
    for _, run in ipairs(ns.routineRuns or {}) do
        if run.id == id then
            ns.sidebarTab, ns.sidebarRoutine = "routines", run.routineId
        end
    end
    ns.Transport.Send({ type = "select", chat = id })
    ns.UI.Refresh()
end
function ns.Chat.DeleteChat(id)
    ns.workStarted[id] = nil
    ns.deletedChats[id] = true
    ns.pendingChats[id] = nil
    ns.db.drafts[id] = nil
    for key, pending in pairs(ns.pendingMessages) do
        if pending.chat == id then
            ns.pendingMessages[key] = nil
        end
    end
    if ns.Transport.CancelPendingChat then
        ns.Transport.CancelPendingChat(id)
    end
    for index = #ns.chats, 1, -1 do
        if ns.chats[index].id == id then
            table.remove(ns.chats, index)
        end
    end
    if ns.active == id then
        ns.active = ns.chats[#ns.chats] and ns.chats[#ns.chats].id or nil
        if ns.draft then
            ns.draft:SetText(ns.active and ns.db.drafts[ns.active] or "")
        end
    end
    ns.db.activeChat = ns.active
    ns.Transport.Send({ type = "delete", chat = id, nextChat = ns.active })
    ns.UI.Refresh()
end
-- Optional explicit text is owned by a separate local review editor. Never copy
-- it into the ordinary SavedVariables-backed composer or clear that draft.
function ns.Chat.Submit(reviewText)
    if ns.modelPending and ns.modelPending[ns.active] then
        return
    end
    local text = (reviewText or ns.draft:GetText() or ""):match("^%s*(.-)%s*$")
    local chat = ns.Chat.Current()
    if text == "" or (chat and chat.status == "working") then
        return false
    end
    if not ns.active or ns.active == "" then
        ns.Chat.NewChat()
    end
    chat = ns.Chat.Current()
    if not chat then
        chat = { id = ns.active, title = "New conversation", messages = {}, status = "idle" }
        table.insert(ns.chats, chat)
        ns.pendingChats[ns.active] = chat
    end
    ns.messageCounter = (ns.messageCounter or 0) + 1
    local messageId = ns.session .. "-message-" .. ns.messageCounter
    local message = { id = messageId, role = "user", text = text }
    ns.pendingMessages[messageId] = { chat = ns.active, message = message }
    ns.workStarted[ns.active] = GetTime()
    local context = ns.Character.CaptureTurn and ns.Character.CaptureTurn()
        or (ns.Character.Capture and ns.Character.Capture({ "character", "location" }))
    ns.Transport.Send({
        type = "say",
        chat = ns.active,
        text = text,
        messageId = messageId,
        context = context,
    })
    chat = ns.Chat.Current()
    if chat then
        chat.messages = chat.messages or {}
        table.insert(chat.messages, message)
        chat.status = "working"
        chat.lastActivityAt = activityTime()
    end
    if not reviewText then
        ns.draft:SetText("")
        ns.db.drafts[ns.active] = ""
    end
    ns.UI.Refresh()
    return true
end
function ns.Chat.MemoryAction(action, slot, key, text)
    ns.memoryCounter = (ns.memoryCounter or 0) + 1
    ns.memoryPending = ns.session .. "-memory-" .. ns.memoryCounter
    ns.memory = { status = "loading" }
    ns.Transport.Send({
        type = "memory_" .. action,
        requestId = ns.memoryPending,
        slot = slot,
        key = key,
        text = text,
        context = ns.Character.Capture({ "character" }),
    })
    if ns.UI.Memory.Refresh then
        ns.UI.Memory.Refresh()
    end
end
function ns.Chat.SetCapability(id, enabled)
    if ns.capabilityPending[id] then
        return
    end
    ns.capabilityCounter = (ns.capabilityCounter or 0) + 1
    local requestId = ns.session .. "-capability-" .. ns.capabilityCounter
    ns.capabilityPending[id] = { requestId = requestId, enabled = enabled }
    ns.capabilityError = nil
    ns.Transport.Send({
        type = "capability_set",
        key = id,
        enabled = enabled,
        requestId = requestId,
    })
    if ns.UI.Capabilities.Refresh then
        ns.UI.Capabilities.Refresh()
    end
end
