local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)
    return env, env.ns
end

local function render(ns, row, chat, message)
    ns.UI.RenderMessageRow(row, chat, message, 400, false)
    for _ = 1, 2000 do
        local _, pending = ns.Markdown.Cache.Step()
        if pending == 0 then
            break
        end
    end
    ns.UI.RenderMessageRow(row, chat, message, 400, false)
end

local function hover(row, over)
    row.IsMouseOver = function()
        return over
    end
    row.copy.IsMouseOver = function()
        return false
    end
end

describe("reply plain text", function()
    local _, ns = setup()
    local plain = ns.Markdown.PlainText

    it("drops Markdown syntax and keeps readable structure", function()
        local source = table.concat({
            "# Title",
            "",
            "Some **bold** and *em* text with `code`.",
            "",
            "- one",
            "- two",
            "  - nested",
            "",
            "1. first",
            "2. second",
            "",
            "```lua",
            "print(1)",
            "```",
            "",
            "> quoted",
            "> more",
            "",
            "---",
            "",
            "[Wowhead](https://www.wowhead.com) and https://x.com",
        }, "\n")
        assert.equal(
            table.concat({
                "Title",
                "",
                "Some bold and em text with code.",
                "",
                "- one",
                "- two",
                "  - nested",
                "",
                "1. first",
                "2. second",
                "",
                "print(1)",
                "",
                "> quoted",
                "> more",
                "",
                "Wowhead (https://www.wowhead.com) and https://x.com",
            }, "\n"),
            plain.FromSource(source)
        )
    end)

    it("writes tasks and table rows as plain lines", function()
        assert.equal(
            "- [x] done\n- [ ] todo\n\nItem: Sword, Price: 10g\nItem: Shield",
            plain.FromSource(
                "- [x] done\n- [ ] todo\n\n| Item | Price |\n| --- | --- |\n"
                    .. "| Sword | 10g |\n| Shield | |"
            )
        )
    end)

    it("resolves references and game links to their names", function()
        local references = {
            sword = { kind = "item", id = 19019, label = "Thunderfury" },
            npc = { kind = "unit", label = "Hogger" },
        }
        assert.equal(
            "Loot [Thunderfury] near Hogger or (reference unavailable); a | bar",
            plain.FromSource(
                "Loot [[ref:sword]] near [[ref:npc]] or [[ref:gone]]; a | bar",
                references
            )
        )
        assert.equal(
            "Link [Thunderfury] here",
            plain.FromSource("Link |cffa335ee|Hitem:19019::::::::60:::::|h[Thunderfury]|h|r here")
        )
    end)

    it("strips client escape codes", function()
        assert.equal(
            "Green |pipe| Icon\nNext",
            plain.StripEscapes("|cff00ff00Green|r ||pipe|| |TInterface\\Icons\\X:0|tIcon|nNext")
        )
    end)

    it("joins a reply's text parts and leaves generated UI out", function()
        assert.equal(
            "A\n\nB",
            plain.FromMessage({
                role = "assistant",
                parts = {
                    { type = "text", text = "**A**" },
                    { type = "ui", id = "card" },
                    { type = "text", text = "B\n" },
                },
            })
        )
    end)
end)

describe("reply copy action", function()
    it("appears only under the pointer and opens the plain text selected", function()
        local env, ns = setup()
        local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
        local message =
            { id = "a1", role = "assistant", text = "Use **Frostbolt** | then `Blink`." }
        local chat = { id = "chat", status = "done", messages = { message } }
        render(ns, row, chat, message)
        local height = row.height
        assert.is_false(row.copy:IsShown())

        hover(row, true)
        row.scripts.OnEnter(row)
        assert.is_true(row.copy:IsShown())
        assert.equal(height, row.height)
        assert.equal("BOTTOMLEFT", row.copy.point[1])
        assert.equal(row, row.copy.point[2])

        row.copy.scripts.OnClick(row.copy)
        local dialog = env.UI_TEST.frames.WispAICopyText
        assert.is_true(dialog:IsShown())
        assert.equal("Copy reply", dialog.title:GetText())
        -- The edit box escapes the bar so it shows, and copies, as typed.
        assert.equal("Use Frostbolt || then Blink.", dialog.edit:GetText())

        -- Typing cannot change the text.
        dialog.edit:SetText("changed")
        dialog.edit.scripts.OnTextChanged(dialog.edit, true)
        assert.equal("Use Frostbolt || then Blink.", dialog.edit:GetText())

        -- The pointer is still over the reply: the action stays.
        row.copy.scripts.OnUpdate(row.copy, 0.2)
        assert.is_true(row.copy:IsShown())
        hover(row, false)
        row.copy.scripts.OnUpdate(row.copy, 0.06)
        assert.is_true(row.copy:IsShown())
        row.copy.scripts.OnUpdate(row.copy, 0.06)
        assert.is_false(row.copy:IsShown())
    end)

    it("is not offered for the player's messages or a reply still being written", function()
        local env, ns = setup()
        local user = { id = "u1", role = "user", text = "Hello" }
        local writing = { id = "a1", role = "assistant", text = "Partial answer" }
        local chat = { id = "chat", status = "working", messages = { user, writing } }
        for _, message in ipairs({ user, writing }) do
            local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
            render(ns, row, chat, message)
            hover(row, true)
            row.scripts.OnEnter(row)
            assert.is_false(row.copy:IsShown())
        end

        local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
        render(ns, row, chat, writing)
        chat.status = "done"
        render(ns, row, chat, writing)
        hover(row, true)
        row.scripts.OnEnter(row)
        assert.is_true(row.copy:IsShown())
        row.scripts.OnHide(row)
        assert.is_false(row.copy:IsShown())
    end)
end)
