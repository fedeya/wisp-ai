local helper = require("addon.tests.support")

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
                        {
                            id = "t2",
                            role = "tool",
                            text = "Reading gear",
                            tool = { label = "Reading gear", status = "running" },
                        },
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
            function findRow(text)
                for _, row in ipairs(visibleRows()) do
                    if row.text:GetText():find(text, 1, true) then
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
                "Reading gear",
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
                "Reading gear",
                "Final answer",
                "Second question",
                "Reading quests",
                "Second answer",
            }) do
                local _, _, _, _, top = findRow(text):GetPoint()
                assert(top < previous, "message chronology must be preserved")
                previous = top
            end
            if surface == "main" then
                assert(
                    not UI_TEST.frames.WispAIProgress.author:IsShown(),
                    "progress continues the same assistant section"
                )
                assert(UI_TEST.frames.WispAIProgress:GetHeight() == 34)
            end
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
            table.insert(ns.chats[1].messages, 3, {
                id = "t1b",
                role = "tool",
                text = "Reading talents",
                tool = { label = "Reading talents", status = "running" },
            })
            refresh()
            local group = findRow("Reading talents")
            assert(
                group.disclosure:IsShown() and not group.text:GetText():find("completed", 1, true)
            )
            assert(#ns.chats[1].messages == 9, "grouping must not rewrite saved history")
            group.disclosure.scripts.OnClick()
            assert(group.text:GetText():find("Reading spells - completed", 1, true))
            assert(group.text:GetText():find("Reading talents - running", 1, true))
            group.disclosure.scripts.OnClick()
            assert(not group.text:GetText():find("Reading spells - completed", 1, true))
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
