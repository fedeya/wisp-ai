-- Offline presentation fixture. No disk transport, live account or AI requests.
local _, C = ...
WispAIDB = {
    sidebar = true,
    sound = false,
    showTools = true,
    drafts = {},
    expandedWidth = 790,
    expandedHeight = 560,
    expandedPosition = { point = "CENTER", x = 0, y = 0 },
    activeChat = "demo-gear",
}
C.Send = function() end
C.StartTransport = function() end
C.Acknowledge = function() end
if not C_EncodingUtil then
    C_EncodingUtil = { SerializeJSON = __json, DeserializeJSON = __unjson }
end
if Minimap then
    Minimap:Hide()
end
C.Capture = function()
    return {
        character = { name = "Aelwyn", class = "MAGE", level = 24 },
        location = { zone = "Westfall" },
    }
end
C.CaptureTurn = C.Capture
C.connected = true
C.modelCatalog = {
    defaultModel = "demo",
    models = { { slug = "demo", displayName = "Demo model", efforts = { "medium" } } },
}
C.contextPolicy = { windowTokens = 128000, compactAt = 0.75 }
C.chats = {
    {
        id = "demo-gear",
        title = "A staff for the road",
        status = "done",
        lastActivityAt = 3,
        messages = {
            { id = "u1", role = "user", text = "Is this staff an upgrade for my mage?" },
            {
                id = "t1",
                role = "tool",
                text = "Reading equipped items",
                tool = { label = "Reading equipped items", status = "completed" },
            },
            {
                id = "t2",
                role = "tool",
                text = "Comparing item stats",
                tool = { label = "Comparing item stats", status = "completed" },
            },
            {
                id = "a1",
                role = "assistant",
                text = "Here is how it compares with your equipped staff:\n\nIntellect: +8\nStamina: +4\nSpirit: -3\n\nYou gain intellect and stamina, but give up some spirit. That is a tradeoff worth considering for your next dungeon.\n\nWant to look at your other gear before deciding?",
            },
        },
        usage = { contextTokens = 6400 },
    },
    {
        id = "demo-quests",
        title = "Next stop: Westfall",
        status = "idle",
        messages = {},
        lastActivityAt = 2,
    },
    {
        id = "demo-tracker",
        title = "Cloth for the journey",
        status = "idle",
        messages = {},
        lastActivityAt = 1,
    },
}
local originalMessages = C.chats[1].messages
local bagCount = 12
C_Item.GetItemCount = function()
    return bagCount
end
GetMoney = function()
    return 10000
end
local tracker = {
    id = "journey",
    title = "Cloth for the journey",
    characterKey = C_EncodingUtil.SerializeJSON({ "Forever", GetRealmName(), UnitName("player") }),
    ui = {
        { id = "cloth", kind = "stat", label = "Linen Cloth", value = "" },
        { id = "progress", kind = "progress", label = "Cloth collected", value = 0 },
        { id = "gold", kind = "stat", label = "Gold", value = "" },
    },
    bindings = {
        { nodeId = "cloth", source = "item_count", itemId = 2589, target = 20 },
        { nodeId = "progress", source = "item_count", itemId = 2589, target = 20 },
        { nodeId = "gold", source = "money", target = 10000 },
    },
}

function WispDemoStage(stage)
    local chat = C.chats[1]
    C.active = chat.id
    C.db.activeChat = chat.id
    C.draft:SetText("")
    C.pendingMessages = {}
    C.workStarted = {}
    chat.activity = {}
    if C.ReceivePanels then
        C.ReceivePanels({})
    end
    WispAIWindow:ClearAllPoints()
    WispAIWindow:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
    WispAIWindow:SetSize(790, 560)
    chat.status = stage == 2 and "working" or "done"
    if stage == 0 then
        chat.messages = {}
        chat.status = "idle"
    elseif stage == 1 then
        chat.messages = {}
        chat.status = "idle"
        C.draft:SetText("Is this staff an upgrade for my mage?")
        C.Submit()
    elseif stage == 2 then
        chat.messages = {
            { id = "u1", role = "user", text = "Is this staff an upgrade for my mage?" },
            {
                id = "t1",
                role = "tool",
                text = "Reading equipped items",
                tool = { label = "Reading equipped items", status = "completed" },
            },
            {
                id = "t2",
                role = "tool",
                text = "Comparing item stats",
                tool = { label = "Comparing item stats", status = "running" },
            },
        }
        chat.activity = { { label = "Comparing item stats", status = "running" } }
    elseif stage == 3 then
        chat.messages = originalMessages
    elseif stage == 4 then
        chat = C.chats[2]
        C.active, C.db.activeChat = chat.id, chat.id
        chat.status = "done"
        chat.messages = {
            { id = "q1", role = "user", text = "Help me plan my next stop in Westfall." },
            {
                id = "q2",
                role = "tool",
                text = "Reading quest log",
                tool = { label = "Reading quest log", status = "completed" },
            },
            {
                id = "q3",
                role = "assistant",
                text = "Let us group the objectives from your quest log before you set off.\n\nStart with the nearby objectives, then head back to the quest giver when you are ready to turn them in.\n\nI can look up an NPC destination if you need a hand finding your next stop.",
            },
        }
    elseif stage == 8 or stage == 9 then
        chat.title = "Comparación de rotaciones"
        WispAIWindow:SetSize(stage == 9 and 580 or 1000, 650)
        chat.messages = {
            {
                id = "sim-user",
                role = "user",
                text = "Compará estas tres rotaciones para mi mago.",
            },
            {
                id = "sim-result",
                role = "assistant",
                text = "Misiles + Explosión obtuvo el mayor DPS en este escenario.",
                ui = {
                    {
                        id = "rotations",
                        kind = "comparison",
                        title = "Nivel 12 · Comparación experimental",
                        unit = "DPS",
                        precision = 1,
                        baseline = "frost",
                        winner = "mixed",
                        winnerLabel = "Mejor DPS en esta prueba",
                        items = {
                            {
                                id = "mixed",
                                label = "Misiles + Explosión de Fuego",
                                value = 25.28,
                                detail = "Completar cada canal antes de la siguiente acción.",
                            },
                            {
                                id = "frost_blast",
                                label = "Escarcha + Explosión de Fuego",
                                value = 20.69,
                                detail = "La diferencia frente a solo Escarcha es mínima.",
                            },
                            {
                                id = "frost",
                                label = "Solo Descarga de Escarcha",
                                value = 20.65,
                            },
                        },
                    },
                    {
                        id = "conditions",
                        kind = "text",
                        text = "Ejemplo · 30 s · 500 iter. · Objetivo nivel 12, 20 m\nSin movimiento ni daño recibido; no mide supervivencia.",
                    },
                },
            },
        }
    elseif stage >= 5 then
        chat = C.chats[3]
        C.active, C.db.activeChat = chat.id, chat.id
        chat.status = "done"
        chat.messages = {
            { id = "p1", role = "user", text = "Keep a tracker for 20 Linen Cloth and 1 gold." },
            {
                id = "p2",
                role = "tool",
                text = "Saving character tracker",
                tool = { label = "Saving character tracker", status = "completed" },
            },
            {
                id = "p3",
                role = "assistant",
                text = "Your tracker is saved for this character.\n\nCloth counts and gold update locally as you play. You can keep this panel open after leaving the conversation.",
            },
        }
        WispAIWindow:SetSize(740, 560)
        WispAIWindow:ClearAllPoints()
        WispAIWindow:SetPoint("CENTER", UIParent, "CENTER", -165, 0)
        bagCount = stage == 5 and 12 or (stage == 6 and 16 or 20)
        C.ReceivePanels({ tracker })
    end
    C.Refresh()
end
