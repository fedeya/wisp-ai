local helper = require("addon.tests.support")
local check = require("luassert")

local function isLoading(row)
    return row.loadingText and row.loadingText:IsVisible()
end

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    do
        ns = helper.namespace()
        SlashCmdList = {}
        function time()
            return 1
        end
    end
    helper.addon("Core.lua", env)
    helper.addon("UI/RichUI.lua", env)
    helper.addon("UI/Window.lua", env)
    helper.addon("Inline/Inline.lua", env)
end

for _, surfaceName in ipairs({ "main", "inline" }) do
    it(
        surfaceName
            .. " groups chronological tool calls and text under one assistant header per turn",
        function()
            local env = helper.env()
            setfenv(1, env)
            setup(env)

            ns.db = { sidebar = true, showTools = true, drafts = {} }
            ns.active = "chat"
            ns.connected = true
            ns.chats = {
                {
                    id = "chat",
                    title = "Test",
                    status = "working",
                    activity = {},
                    messages = {
                        { id = "u1", role = "user", text = "First question" },
                        {
                            id = "t1",
                            role = "tool",
                            text = "Reading spells",
                            tool = { label = "Reading spells", status = "completed" },
                        },
                        { id = "a1", role = "assistant", text = "Checking gear" },
                        { id = "a2", role = "assistant", text = "Final answer" },
                        { id = "u2", role = "user", text = "Second question" },
                        {
                            id = "t3",
                            role = "tool",
                            text = "Reading quests",
                            tool = { label = "Reading quests", status = "completed" },
                        },
                        { id = "a3", role = "assistant", text = "Second answer" },
                    },
                },
            }
            ns.UI.BuildUI()
            ns.Inline.InitInline()
            surface = surfaceName
            if surface == "inline" then
                ns.inlineId = "chat"
                UI_TEST.frames.WispAIInline:Show()
            end
            function refresh()
                if surface == "main" then
                    ns.UI.Refresh()
                else
                    ns.Inline.RefreshInline()
                end
            end
            function visibleRows()
                local result = {}
                for _, widget in ipairs(UI_TEST.widgets) do
                    if
                        type(widget.author) == "table"
                        and type(widget.text) == "table"
                        and widget:IsShown()
                    then
                        local main = widget.parent == UI_TEST.frames.WispAIProgress.parent
                        if main == (surface == "main") then
                            result[#result + 1] = widget
                        end
                    end
                end
                return result
            end
            function findRow(text, except)
                for _, row in ipairs(visibleRows()) do
                    if row ~= except and row.text:GetText():find(text, 1, true) then
                        return row
                    end
                end
                error("Missing message: " .. text)
            end
            refresh()
            local first = findRow("Reading spells")
            assert(
                not first.disclosure:IsShown(),
                "a single tool without extra details must not have an expander"
            )
            assert(first.author:IsShown() and first.author:GetText() == "Wisp AI")
            local _, _, _, _, textTop = first.text:GetPoint()
            assert(textTop == -20, "the first tool must be below the assistant name")
            for _, text in ipairs({
                "Checking gear",
                "Final answer",
                "Second answer",
            }) do
                assert(
                    not findRow(text).author:IsShown(),
                    "continuations must share the assistant header"
                )
            end
            assert(
                findRow("Reading quests").author:IsShown(),
                "a new user turn needs a new assistant header"
            )
            local previous = 1
            for _, text in ipairs({
                "First question",
                "Reading spells",
                "Checking gear",
                "Final answer",
                "Second question",
                "Reading quests",
                "Second answer",
            }) do
                local _, _, _, _, top = findRow(text):GetPoint()
                assert(top < previous, "message chronology must be preserved")
                previous = top
            end
            local preamble = findRow("Checking gear")
            local _, _, _, _, toolTop = first:GetPoint()
            local _, _, _, _, preambleTop = preamble:GetPoint()
            local _, _, _, _, answerTop = findRow("Final answer"):GetPoint()
            check.equal(toolTop - first:GetHeight() - 6, preambleTop)
            check.equal(preambleTop - preamble:GetHeight(), answerTop)
            local progress = surface == "main" and UI_TEST.frames.WispAIProgress
                or UI_TEST.frames.WispAIInlineProgress
            assert(not progress:IsShown(), "a visible reply takes the place of thinking")
            ns.db.showTools = false
            refresh()
            assert(
                findRow("Checking gear").author:IsShown(),
                "hiding tools must move the header onto visible text"
            )
            assert(findRow("Second answer").author:IsShown())
            ns.db.showTools = true
            refresh()
            assert(findRow("Reading spells").author:IsShown())
            assert(not findRow("Checking gear").author:IsShown())
            local writes = UI_TEST.textWrites
            refresh()
            assert(UI_TEST.textWrites == writes, "unchanged groups must not rewrite rows")
            local user = findRow("First question")
            local _, _, _, userX = user:GetPoint()
            local _, _, _, assistantX = findRow("Checking gear"):GetPoint()
            assert(
                userX > 0 and assistantX == 0 and user.bubble:IsShown(),
                "user bubbles sit on the right"
            )
            assert(user:GetWidth() < findRow("Checking gear"):GetWidth())

            local replyRow = findRow("Second answer")
            local reply = table.remove(ns.chats[1].messages)
            local completedCall = table.remove(ns.chats[1].messages)
            refresh()
            assert(progress:IsShown(), "past replies do not suppress thinking in a new turn")
            assert(progress.author:IsShown() and progress:GetHeight() == 43)
            assert(isLoading(progress))
            local loading = progress.loadingText
            loading.scripts.OnUpdate(loading, 0.2)
            local initial = progress.title:GetText()
            loading.scripts.OnUpdate(loading, 0.2)
            local animated = progress.title:GetText()
            assert(animated ~= initial and animated:find("|c", 1, true))
            local plain = animated:gsub("|c" .. string.rep("%x", 8), ""):gsub("|r", "")
            check.equal("Thinking", plain)
            local pending = { chat = "chat" }
            ns.pendingMessages.u2 = pending
            ns.workStarted.chat = GetTime()
            local question = findRow("Second question")
            local bubbleHeight = question:GetHeight()
            refresh()
            local delivery = question.delivery
            assert(delivery:IsShown() and #delivery.dots == 3 and not progress:IsShown())
            assert(not delivery.waiting:IsShown() and not question.author:IsShown())
            local _, anchor, relativePoint = delivery:GetPoint()
            assert(anchor == question.bubble and relativePoint == "BOTTOMRIGHT")
            assert(question:GetHeight() == bubbleHeight + delivery:GetHeight())
            UI_TEST.now = 15
            delivery.scripts.OnUpdate(delivery)
            assert(
                delivery.waiting:IsShown() and delivery.waiting:GetText() == "Waiting for bridge"
            )
            assert(question:GetHeight() == bubbleHeight + delivery:GetHeight())
            pending.acknowledged = true
            refresh()
            assert(not delivery:IsShown() and progress:IsShown())
            assert(question:GetHeight() == bubbleHeight)

            reply.text, reply.streaming = " \n", true
            table.insert(ns.chats[1].messages, reply)
            refresh()
            assert(progress:IsShown(), "whitespace does not replace the thinking row")
            table.remove(ns.chats[1].messages)

            table.insert(ns.chats[1].messages, completedCall)
            refresh()
            assert(not progress:IsShown() and not isLoading(progress))
            local waitingGroup = findRow("Reading quests")
            assert(isLoading(waitingGroup) and not waitingGroup.icon:IsShown())
            local _, _, _, toolX, toolY = waitingGroup.text:GetPoint()
            check.same({ 0, -20 }, { toolX, toolY })

            local call = {
                id = "t3b",
                role = "tool",
                text = "Reading talents",
                tool = {
                    label = "Reading talents",
                    status = "running",
                    inputPreview = '{"sections":["talents"]}',
                },
            }
            table.insert(ns.chats[1].messages, call)
            refresh()
            local group = findRow("Reading talents")
            assert(group.disclosure:IsShown() and group.text:GetText() == "Reading talents")
            assert(isLoading(group) and not group.icon:IsShown())
            assert(not progress:IsShown(), "the active tool replaces the thinking row")
            assert(#ns.chats[1].messages == 7, "grouping must not rewrite saved history")
            local _, _, _, labelLeft = group.text:GetPoint()
            local _, _, _, chevronLeft = group.chevron:GetPoint()
            check.equal(labelLeft + group.text:GetUnboundedStringWidth() + 4, chevronLeft)
            call.tool.label = string.rep("Reading character details ", 8)
            refresh()
            local _, _, _, wrappedChevronLeft = group.chevron:GetPoint()
            check.equal(group:GetWidth(), wrappedChevronLeft + group.chevron:GetWidth())
            assert(group.text:GetStringHeight() > 18)
            call.tool.label = "Reading talents"
            refresh()
            local viewport = group:GetParent():GetParent()
            viewport:SetHeight(64)
            refresh()
            local function scrollToBottom()
                local offset = viewport:GetVerticalScrollRange()
                if surface == "main" then
                    UI_TEST.frames.WispAITranscriptScrollBar:SetValue(offset)
                else
                    viewport:SetVerticalScroll(offset)
                end
                return offset
            end
            local groupOffset = scrollToBottom()
            group.disclosure.scripts.OnClick()
            assert(viewport:GetVerticalScrollRange() > groupOffset)
            check.equal(groupOffset, viewport:GetVerticalScroll())
            assert(group.text:GetText() == "Reading talents")
            check.same({ 0, 1 / 8, 0, 1 }, findRow("Reading quests").icon.texCoord)
            local child = findRow("Reading talents", group)
            assert(isLoading(child) and not child.icon:IsShown() and child.disclosure:IsShown())
            local detailOffset = scrollToBottom()
            child.disclosure.scripts.OnClick()
            assert(viewport:GetVerticalScrollRange() > detailOffset)
            check.equal(detailOffset, viewport:GetVerticalScroll())
            assert(child.toolDetail:IsShown())
            check.equal('Input  {"sections":["talents"]}', child.toolDetail:GetText())
            call.tool.status = "failed"
            call.tool.label = "Tried to read talents"
            call.tool.resultPreview = "Talents are unavailable | retry"
            refresh()
            assert(not progress:IsShown() and group.text:GetText() == "Tried to read talents  +1")
            assert(isLoading(group))
            check.same({ 2 / 8, 3 / 8, 0, 1 }, child.icon.texCoord)
            assert(not isLoading(child) and child.icon:IsShown())
            check.equal(
                'Input  {"sections":["talents"]}\n\nResult  Talents are unavailable || retry',
                child.toolDetail:GetText()
            )
            group.disclosure.scripts.OnClick()
            assert(not child:IsShown())

            reply.text = "Second answer"
            table.insert(ns.chats[1].messages, reply)
            refresh()
            assert(replyRow:IsShown() and not progress:IsShown())
            check.equal("S", replyRow.text:GetText())
            assert(not isLoading(group) and group.icon:IsShown())
            reply.streaming = false
            refresh()
            assert(not progress:IsShown(), "thinking stays hidden after the last text chunk")
            replyRow.scripts.OnUpdate(replyRow, 1)
            check.equal(reply.text, replyRow.text:GetText())

            local simulation = {
                id = "simulation-after-text",
                role = "tool",
                text = "Simulating DPS",
                tool = { status = "running", label = "Simulating DPS" },
            }
            local messages = ns.chats[1].messages
            table.insert(messages, simulation)
            refresh()
            local simulationGroup = findRow("Simulating DPS")
            check.equal("Tried to read talents  +1", group.text:GetText())
            assert(group.y < replyRow.y and replyRow.y < simulationGroup.y)
            assert(not isLoading(group) and isLoading(simulationGroup))

            simulation.tool.status, simulation.tool.label = "completed", "Simulated DPS"
            refresh()
            assert(
                isLoading(simulationGroup),
                "the loader stays on while the comparison is prepared"
            )
            check.equal("Simulated DPS", simulationGroup.text:GetText())
            assert(group.y < replyRow.y and replyRow.y < simulationGroup.y)

            table.insert(messages, {
                id = "presentation-progress-comparison",
                role = "tool",
                text = "Creating comparison",
                tool = { status = "running", label = "Creating comparison" },
            })
            refresh()
            assert(isLoading(simulationGroup) and not progress:IsShown())
            check.equal("Creating comparison", simulationGroup.text:GetText())
            assert(group.y < replyRow.y and replyRow.y < simulationGroup.y)

            table.remove(messages)
            table.insert(messages, {
                id = "simulation-comparison",
                role = "assistant",
                text = "",
                ui = { { id = "comparison-card", kind = "card", title = "DPS comparison" } },
                parts = { { type = "ui", id = "comparison-card" } },
            })
            refresh()
            assert(not isLoading(simulationGroup) and not progress:IsShown())
            local comparisonRow
            for _, row in ipairs(visibleRows()) do
                if row.replyView and row.replyView.messageId == "simulation-comparison" then
                    comparisonRow = row
                end
            end
            assert(comparisonRow and comparisonRow.rich.widgets["comparison-card"]:IsShown())
            assert(group.y < replyRow.y and replyRow.y < simulationGroup.y)
            assert(simulationGroup.y < comparisonRow.y)

            table.insert(ns.chats[1].messages, {
                id = "final-only",
                role = "assistant",
                phase = "reply",
                streaming = false,
                text = "A reply delivered as a single snapshot",
            })
            ns.chats[1].status = "done"
            refresh()
            local finalOnly = findRow("A")
            assert(finalOnly:IsShown() and finalOnly.scripts.OnUpdate)
            finalOnly.scripts.OnUpdate(finalOnly, 1)
            check.equal("A reply delivered as a single snapshot", finalOnly.text:GetText())

            local fresh = { id = "fresh", status = "idle", messages = {} }
            table.insert(ns.chats, fresh)
            if surface == "main" then
                ns.active = fresh.id
            else
                ns.inlineId = fresh.id
            end
            refresh()
            fresh.messages = {
                { id = "first-question", role = "user", text = "First question in a new chat" },
                {
                    id = "first-reply",
                    role = "assistant",
                    phase = "reply",
                    streaming = false,
                    text = "Zebra starts the first reply.",
                },
            }
            fresh.status = "done"
            refresh()
            local firstReply = findRow("Z")
            check.equal("Z", firstReply.text:GetText())
            firstReply.scripts.OnUpdate(firstReply, 1)
            check.equal("Zebra starts the first reply.", firstReply.text:GetText())
            if surface == "main" then
                ns.active = "chat"
            else
                ns.inlineId = "chat"
            end

            ns.chats[1].messages =
                { { id = "long", role = "assistant", text = string.rep("Long reply ", 1000) } }
            ns.chats[1].status = "done"
            refresh()
            local scroll, jump
            if surface == "main" then
                scroll = UI_TEST.frames.WispAIProgress.parent.parent
                for _, w in ipairs(UI_TEST.widgets) do
                    if w:GetText() == "New messages v" and w.name ~= "WispAIInlineNewMessages" then
                        jump = w
                    end
                end
                UI_TEST.frames.WispAITranscriptScrollBar:SetValue(0)
            else
                scroll = UI_TEST.frames.WispAIInlineNewMessages.point[2]
                jump = UI_TEST.frames.WispAIInlineNewMessages
                scroll:SetVerticalScroll(0)
            end
            refresh()
            assert(not jump:IsShown(), "scrolling up alone is not a new message")
            ns.chats[1].messages[1].text = ns.chats[1].messages[1].text .. "New streamed text"
            refresh()
            assert(
                jump:IsShown() and scroll:GetVerticalScroll() == 0,
                "new content must preserve the reader position"
            )
            jump.scripts.OnClick()
            assert(
                not jump:IsShown() and scroll:GetVerticalScroll() > 0,
                "jump resumes reading at the latest reply"
            )
        end
    )
end
