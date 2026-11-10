local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.C = {}
    helper.addon("UI.lua", env)
    helper.addon("RichUI.lua", env)
    return env, env.C
end

local function message(text)
    return { id = "reply", role = "assistant", text = text }
end

it(
    "projects saved Markdown locally without changing source, references or native components",
    function()
        local _, C = setup()
        local source =
            "Antes.\n\n| Pieza | Estado |\n| :--- | ---: |\n| [[ref:robe]] | Equipada |\n\nDespués."
        local original = message(source)
        original.rawReply = "original reply events"
        original.references = { robe = { kind = "item", id = 100, label = "Toga" } }
        original.ui = { { id = "existing", kind = "stat", label = "DPS", value = "1" } }
        local before = C.RichSignature(original)
        local view = C.MarkdownTables.project(original)
        assert.are_not.equal(original, view)
        assert.equal(before, C.RichSignature(original))
        assert.equal(source, view.text)
        assert.equal(original.rawReply, view.rawReply)
        assert.equal(original.references, view.references)
        assert.equal(original.ui[1], view.ui[1])
        assert.same({ label = "Pieza", align = "left" }, view.ui[2].columns[1])
        assert.equal("right", view.ui[2].columns[2].align)
        assert.is_truthy(view.ui[2].rows[1][1]:find("|Hitem:100|h[Toga]|h", 1, true))
        assert.same({
            { type = "text", text = "Antes.\n\n" },
            { type = "ui", id = "markdown_table_1" },
            { type = "text", text = "\nDespués." },
            { type = "ui", id = "existing" },
        }, view.parts)
        assert.equal(
            view,
            C.MarkdownTables.project(view),
            "already projected messages stay idempotent"
        )
    end
)

it("consumes inline AST nodes without reparsing code, escaped pipes or emphasis", function()
    local env, C = setup()
    C.FormatText = function()
        error("Markdown cells must consume the AST, not the legacy text formatter")
    end
    local original = message(
        "A | B\n--- | :---:\na\\|b | **Use `a**b` now**\n`[[ref:robe]]` | \\*literal* &amp; &#124;\n"
    )
    local view = C.MarkdownTables.project(original)
    local node = view.ui[1]
    assert.equal("a||b", node.rows[1][1])
    assert.equal("|cffe3c77eUse a**b now|r", node.rows[1][2])
    assert.equal("[[ref:robe]]", node.rows[2][1])
    assert.equal("*literal* & ||", node.rows[2][2])
    local host = env.CreateFrame("Frame")
    C.RenderRichUI(host, {}, view, 600)
    assert.equal("a||b", host.widgets[node.id].tableRows[2].cells[1]:GetText())
    assert.equal(node.rows[1][2], host.widgets[node.id].tableRows[2].cells[2]:GetText())
end)

it(
    "renders link labels, image alt text and HTML literally with only declared native links",
    function()
        local _, C = setup()
        local original = message(
            "A | B\n---|---\n[**label**](https://example.com/a**b) | ![alt](https://example.com/a.png)\n<b>raw</b> | &#124;Hspell:122&#124;h[fake]&#124;h\n~~old **bold** end~~ | **[[ref:spell]] tail**\n"
        )
        original.references = { spell = { kind = "spell", id = 122, label = "Nova" } }
        local rows = C.MarkdownTables.project(original).ui[1].rows
        assert.same({ "|cffe3c77elabel|r", "alt" }, rows[1])
        assert.same({ "<b>raw</b>", "||Hspell:122||h[fake]||h" }, rows[2])
        assert.equal("|cff99948aold |cffe3c77ebold|r|cff99948a end|r", rows[3][1])
        assert.is_truthy(rows[3][2]:find("|Hspell:122|h[Nova]|h|r|cffe3c77e tail|r", 1, true))
    end
)

it(
    "uses GFM alignment and rectangular rows while leaving code and container tables in prose",
    function()
        local _, C = setup()
        local view =
            C.MarkdownTables.project(message("A | B\n:- | -:\n1\n2 | 3 | ignored\n4 | 5\n"))
        assert.same({ { "1", "" }, { "2", "3" }, { "4", "5" } }, view.ui[1].rows)
        local wire = "A | B\n--- | ---\n1 | 2\n"
        for _, source in ipairs({
            "```text\n" .. wire .. "```",
            "~~~\n" .. wire .. "~~~",
            "    A | B\n    --- | ---\n    1 | 2\n",
            "> A | B\n> --- | ---\n> 1 | 2\n",
            "- A | B\n  --- | ---\n  1 | 2\n",
            "<pre>\n" .. wire .. "</pre>\n",
        }) do
            local original = message(source)
            assert.equal(original, C.MarkdownTables.project(original))
        end
    end
)

it("maps normalized source positions back to exact CRLF, CR and Unicode prose", function()
    local _, C = setup()
    for _, newline in ipairs({ "\n", "\r\n", "\r" }) do
        local before = "ñ 😀\000before" .. newline .. newline
        local after = newline .. "Después \255"
        local source = before
            .. "A | B"
            .. newline
            .. "---|---"
            .. newline
            .. "ñ|😀"
            .. newline
            .. after
        local view = C.MarkdownTables.project(message(source))
        assert.equal(source, view.text)
        assert.equal(before, view.parts[1].text)
        assert.equal(after, view.parts[3].text)
        assert.equal("ñ", view.ui[1].rows[1][1])
    end
    local view = C.MarkdownTables.project(message("Prose\nA | B\n---|---\nx|y"))
    assert.equal("Prose\n", view.parts[1].text, "a table may interrupt a paragraph")
    assert.equal("ui", view.parts[2].type)
end)

it("preserves explicit component order, avoids IDs and handles old cached table layouts", function()
    local _, C = setup()
    local source = "A | B\n---|---\nx|y\n"
    local original = message(source .. source)
    original.ui = {
        { id = "markdown_table_1", kind = "stat", label = "Existing", value = "1" },
        { id = "child", parent = "markdown_table_1", kind = "text", text = "Child" },
    }
    original.parts = {
        { type = "text", text = source },
        { type = "ui", id = "markdown_table_1" },
        { type = "text", text = source },
    }
    local before = C.RichSignature(original)
    local view = C.MarkdownTables.project(original)
    assert.same({
        { type = "ui", id = "markdown_table_2" },
        { type = "ui", id = "markdown_table_1" },
        { type = "ui", id = "markdown_table_3" },
    }, view.parts)
    assert.equal(before, C.RichSignature(original))
    assert.equal(view, C.MarkdownTables.project(view))
    local legacy = message(source)
    legacy.ui = { { id = "old_table", kind = "table", columns = {}, rows = {} } }
    legacy.parts = { { type = "ui", id = "old_table" } }
    assert.equal(
        legacy,
        C.MarkdownTables.project(legacy),
        "a cached table must not be duplicated from message.text"
    )
end)

it(
    "shows header-only and single-column tables and grows cells after many streaming updates",
    function()
        local env, C = setup()
        local original = message("")
        original.streaming = true
        local chat = { id = "chat", status = "working", messages = { original } }
        local row = C.MakeMessageRow(env.CreateFrame("Frame"))
        local function render(delta)
            original.text = original.text .. delta
            C.RenderMessageRow(row, chat, original, 210, true)
            assert.is_nil(original.ui)
            assert.is_nil(original.parts)
        end
        for _ = 1, 9 do
            render("Antes. ")
        end
        render("\n\n| Pieza | Estado |\n| --- | --- |\n")
        local widget = row.rich.widgets.markdown_table_1
        assert.is_true(
            widget.tableRows[1]:IsShown(),
            "headers remain visible before any rows exist"
        )
        assert.equal("Pieza", widget.tableRows[1].cells[1]:GetText())
        assert.is_false(widget.tableRows[1].labels[1]:IsShown())
        render("| To")
        assert.is_false(widget.tableRows[1]:IsShown())
        assert.equal("To", widget.tableRows[2].cells[1]:GetText())
        render("ga | Equi")
        assert.equal("Toga", widget.tableRows[2].cells[1]:GetText())
        assert.equal("Equi", widget.tableRows[2].cells[2]:GetText())
        local count = #env.UI_TEST.widgets
        for index = 1, 12 do
            render("x")
            assert.equal("Equi" .. string.rep("x", index), widget.tableRows[2].cells[2]:GetText())
            assert.equal(count, #env.UI_TEST.widgets, "cell updates reuse native widgets")
        end
        render(" |\n\nDespués.")
        original.streaming, chat.status = false, "done"
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(widget, row.rich.widgets.markdown_table_1)
        assert.is_true(widget.tableRows[1]:IsShown())
        original.text = "| One |\n|---|"
        C.RenderMessageRow(row, chat, original, 210, true)
        assert.equal("One", widget.tableRows[1].cells[1]:GetText())
        assert.is_false(widget.tableRows[1].cells[2]:IsShown())
        assert.is_false(widget.tableRows[2]:IsShown())
        assert.is_false(row.text:IsShown())
        assert.is_true(widget.tableRows[1]:IsShown())
    end
)

it(
    "caches parsing across resize, refresh and completion but refreshes late references and item data",
    function()
        local env, C = setup()
        local original = message("[[ref:robe]] | State\n---|---\n**[[ref:robe]]** | partial")
        original.streaming = true
        local chat = { id = "chat", status = "working", messages = { original } }
        local row = C.MakeMessageRow(env.CreateFrame("Frame"))
        local parse, calls = C.Markdown.parse, 0
        C.Markdown.parse = function(...)
            calls = calls + 1
            return parse(...)
        end
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(1, calls)
        local widget = row.rich.widgets.markdown_table_1
        assert.equal(
            "|cffe3c77e(reference unavailable)|cffe3c77e|r",
            widget.tableRows[2].cells[1]:GetText()
        )
        C.RenderMessageRow(row, chat, original, 600, true)
        C.RenderMessageRow(row, chat, original, 210, false)
        original.streaming, chat.status = false, "done"
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(1, calls)
        original.references = { robe = { kind = "item", id = 100, label = "Toga" } }
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(2, calls)
        assert.is_truthy(
            widget.tableRows[1].cells[1]:GetText():find("|Hitem:100|h[Toga]|h", 1, true)
        )
        original.references.robe.label = "Toga nueva"
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(3, calls)
        assert.is_truthy(widget.tableRows[2].cells[1]:GetText():find("[Toga nueva]", 1, true))
        env.GetItemIcon = function()
            return "LoadedIcon"
        end
        C.itemRevision = C.itemRevision + 1
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(4, calls)
        assert.is_truthy(widget.tableRows[2].cells[1]:GetText():find("|TLoadedIcon:", 1, true))
        local user = { id = "user", role = "user", text = original.text }
        C.RenderMessageRow(row, chat, user, 600, true)
        assert.is_nil(row.markdownUI)
        assert.is_false(widget:IsShown())
        assert.equal(4, calls)
    end
)

it(
    "refreshes explicit UI edits and uses current message metadata with a cached table view",
    function()
        local env, C = setup()
        local original = message("A|B\n---|---\nx|y")
        original.ui = { { id = "action", kind = "button", label = "Continue" } }
        local chat = { id = "chat", status = "done", messages = { original } }
        local row = C.MakeMessageRow(env.CreateFrame("Frame"))
        local action
        C.PanelAction = function(_, current, node)
            action = { current.id, node.label }
        end
        C.RenderMessageRow(row, chat, original, 600, true)
        local projected = row.markdownUI
        original.id = "replacement"
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(projected, row.markdownUI, "changing metadata reuses presentation data")
        row.rich.widgets.action.control.scripts.OnClick()
        assert.same({ "replacement", "Continue" }, action)
        original.ui[1].label = "Changed"
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.equal("Changed", row.rich.widgets.action.control:GetText())
        row.rich.widgets.action.control.scripts.OnClick()
        assert.same({ "replacement", "Changed" }, action)
        original.parts = { { type = "text", text = "Plain prose" }, { type = "ui", id = "action" } }
        C.RenderMessageRow(row, chat, original, 600, true)
        assert.is_nil(row.markdownUI)
        assert.is_false(row.rich.widgets.markdown_table_1:IsShown())
        assert.equal("Plain prose", row.rich.prose[1]:GetText())
    end
)

it("keeps oversized tables as original prose and bounds the number of native widgets", function()
    local _, C = setup()
    local wire = "A | B\n---|---\nx|y\n"
    for _, source in ipairs({
        "A|B|C|D|E|F|G\n---|---|---|---|---|---|---\n1|2|3|4|5|6|7",
        "A|B\n---|---\n" .. string.rep("x", 301) .. "|y",
        "A|B\n---|---\n" .. string.rep("😀", 75) .. "|y",
        "A|B\n---|---\n" .. string.rep("x|y\n", 21),
        string.rep("x", 101) .. "|B\n---|---\nx|y",
    }) do
        local original = message(source)
        assert.equal(original, C.MarkdownTables.project(original))
        local view = C.MarkdownTables.project(message(source .. "\n\n" .. wire))
        assert.equal(source .. "\n\n", view.parts[1].text)
        assert.equal(1, #view.ui)
    end
    local many = C.MarkdownTables.project(message(string.rep("| A |\n|---|\nx\n\n", 25)))
    assert.equal(24, #many.ui)
    assert.is_truthy(many.parts[#many.parts].text:find("| A |", 1, true))
    local large = "A|B|C|D|E|F\n---|---|---|---|---|---\n"
        .. string.rep("1|2|3|4|5|6\n", 20)
        .. "\n"
    local bounded = C.MarkdownTables.project(message(string.rep(large, 5)))
    assert.equal(4, #bounded.ui, "600 cells includes headers")
    local emojiRow = string.rep(string.rep("😀", 4) .. "|", 6):sub(1, -2)
    local expanded = "A|B|C|D|E|F\n---|---|---|---|---|---\n"
        .. string.rep(emojiRow .. "\n", 20)
        .. "\n"
    local formatted = C.MarkdownTables.project(message(expanded .. expanded))
    assert.equal(1, #formatted.ui, "native emoji textures count toward the formatted-text budget")
    assert.is_truthy(formatted.parts[#formatted.parts].text:find(emojiRow, 1, true))
end)

it("leaves the complete source available on a parser budget failure", function()
    local _, C = setup()
    local original = message(string.rep("x", 1024 * 1024) .. "|")
    local view, err = C.MarkdownTables.project(original)
    assert.equal(original, view)
    assert.equal("max_bytes", err.code)
    local first = "A|B\n---|---\nx|y"
    original.parts = { { type = "text", text = first }, { type = "text", text = original.text } }
    view, err = C.MarkdownTables.project(original)
    assert.equal(original, view, "a later failure must not publish a partially projected message")
    assert.is_nil(view.ui)
    assert.equal("max_bytes", err.code)
end)
