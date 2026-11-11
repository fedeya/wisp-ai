local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)
    return env, env.ns
end

local function message(source)
    return { id = "reply", role = "assistant", text = source }
end

local function settled(ns, original)
    for _ = 1, 2000 do
        local view = ns.Markdown.ReplyView.Project(original)
        if not view._markdownPending then
            return view
        end
        ns.Markdown.Cache.Step()
    end
    error("Markdown did not settle")
end

it("uses the same AST text formatting in prose, headings and table cells", function()
    local _, ns = setup()
    local source =
        "**Use `a**b` now**\n\n# **Use `a**b` now**\n\nA|B\n---|---\n**Use `a**b` now**|\\*literal* &amp; &#124;"
    local view = settled(ns, message(source))
    local expected = "|cffe3c77eUse a**b now|r"
    assert.equal(expected, view.parts[1].text)
    assert.equal(expected, view.parts[2].text)
    assert.equal("heading", view.parts[2].style)
    assert.equal(expected, view.ui[1].rows[1][1])
    assert.equal("*literal* & ||", view.ui[1].rows[1][2])
end)

it("renders reviewed inline expressions and linked image labels consistently", function()
    local _, ns = setup()
    local source = "**2*3=6**\n\n[![**alt**](image.png)](https://outer)\n\n[a\\*b]\n\n[a\\*b]: /url"
    local view = settled(ns, message(source))
    assert.equal("|cffe3c77e2*3=6|r", view.parts[1].text)
    local link = "|cff80c8ef|H" .. ns.Markdown.Links.Encode("https://outer") .. "|h"
    assert.equal(link .. "|cffe3c77ealt|r|cff80c8ef|h|r", view.parts[2].text)
    assert.equal("a*b", view.parts[3].text)
    assert.equal("|cffe3c77e2*3=6|r", ns.UI.FormatText("**2*3=6**"))
    assert.equal(link .. "alt|h|r", ns.UI.FormatText("[![alt](image.png)](https://outer)"))
end)

it("applies the profile's entities and hard breaks to native UI labels too", function()
    local env, ns = setup()
    local expected = "AT&T <tag> ||"
    assert.equal(expected, ns.UI.FormatText("AT&amp;T &lt;tag&gt; &#124;"))
    assert.equal("first\nsecond", ns.UI.FormatText("first  \nsecond"))
    local view = settled(
        ns,
        message("AT&amp;T &lt;tag&gt; &#124;\n\nA|B\n---|---\nAT&amp;T &lt;tag&gt; &#124;|x")
    )
    assert.equal(expected, view.parts[1].text)
    assert.equal(expected, view.ui[1].rows[1][1])
    local host = env.CreateFrame("Frame")
    ns.UI.RenderRichUI(
        host,
        {},
        { ui = { { id = "label", kind = "text", text = "AT&amp;T &lt;tag&gt; &#124;" } } },
        300
    )
    assert.equal(expected, host.widgets.label.title:GetText())
end)

it("preserves canonical source, native component ordering and reference data", function()
    local _, ns = setup()
    local source = "Before.\r\n\r\nA|B\r\n---|---\r\n[[ref:robe]]|Equipped\r\n\r\nAfter ñ."
    local original = message(source)
    original.rawReply = "source events"
    original.references = { robe = { kind = "item", id = 100, label = "Toga" } }
    original.ui = { { id = "markdown_table_1", kind = "stat", label = "DPS", value = "1" } }
    local before = ns.UI.RichSignature(original)
    local view = settled(ns, original)
    assert.equal(before, ns.UI.RichSignature(original))
    assert.equal(source, view.text)
    assert.equal(original.rawReply, view.rawReply)
    assert.equal(original.references, view.references)
    assert.equal(original.ui[1], view.ui[1])
    assert.equal("Before.", view.parts[1].text)
    assert.same({ type = "ui", id = "markdown_table_2", indent = 0 }, view.parts[2])
    assert.equal("After ñ.", view.parts[3].text)
    assert.same({ type = "ui", id = "markdown_table_1" }, view.parts[4])
    assert.is_truthy(view.ui[2].rows[1][1]:find("|Hitem:100|h[Toga]|h", 1, true))
    assert.equal(view, ns.Markdown.ReplyView.Project(view))
end)

it(
    "renders interleaved presentation parts while code and escaped references stay literal",
    function()
        local _, ns = setup()
        local before = "# Antes\n\n~~~text\n[[ref:example]]\n~~~\n\nA|B\n---|---\n[[ref:nova]]|20"
        local after = "**Después** \\[[ref:escaped]]"
        local original = message(before .. after)
        original.references = { nova = { kind = "spell", id = 122, label = "Nova" } }
        original.ui = {
            {
                id = "comparison",
                kind = "comparison",
                unit = "DPS",
                items = {
                    { id = "a", label = "A", value = 10 },
                    { id = "b", label = "B", value = 20 },
                },
            },
        }
        original.parts = {
            { type = "text", text = before },
            { type = "ui", id = "comparison" },
            { type = "text", text = after },
        }
        local signature = ns.UI.RichSignature(original)
        local view = settled(ns, original)
        assert.equal(signature, ns.UI.RichSignature(original))
        assert.equal(original.text, view.text)
        assert.equal(original.ui[1], view.ui[1])
        assert.equal("heading", view.parts[1].style)
        assert.equal("code", view.parts[2].style)
        assert.is_truthy(view.parts[2].text:find("[[ref:example]]", 1, true))
        assert.same({ type = "ui", id = "markdown_table_1", indent = 0 }, view.parts[3])
        assert.same({ type = "ui", id = "comparison" }, view.parts[4])
        assert.is_truthy(view.parts[5].text:find("[[ref:escaped]]", 1, true))
        assert.is_truthy(view.ui[2].rows[1][1]:find("|Hspell:122|h[Nova]|h", 1, true))
    end
)

it("renders lists, tasks, quotes and code through the shared document view", function()
    local _, ns = setup()
    local view = settled(
        ns,
        message(
            "## Gear\n\n- first\n- [x] ready\n\n> quoted **word**\n\n```lua\n**literal** | [[ref:x]]\n```"
        )
    )
    local seen = {}
    for _, part in ipairs(view.parts) do
        if part.type == "text" then
            seen[#seen + 1] = part.text
            if part.style == "code" then
                assert.is_truthy(part.text:find("**literal** || [[ref:x]]", 1, true))
            end
        end
    end
    assert.is_truthy(table.concat(seen, "\n"):find("- first", 1, true))
    assert.is_truthy(table.concat(seen, "\n"):find("[x] ready", 1, true))
    assert.is_truthy(table.concat(seen, "\n"):find("> quoted |cffe3c77eword|r", 1, true))
    assert.equal("heading", view.parts[1].style)
    assert.equal(2, view.parts[1].level)
end)

it("resolves late and incomplete references locally while code remains literal", function()
    local _, ns = setup()
    local original = message("[[ref:robe]] `[[ref:robe]]` [[ref:par")
    original.streaming = true
    local first = settled(ns, original)
    assert.equal("... [[ref:robe]] ...", first.parts[1].text)
    original.references = { robe = { kind = "item", id = 100, label = "Toga" } }
    local linked = settled(ns, original).parts[1].text
    assert.is_truthy(linked:find("|Hitem:100|h[Toga]|h", 1, true))
    assert.is_truthy(linked:find(" [[ref:robe]] ...", 1, true))
    original.streaming = false
    local final = settled(ns, original).parts[1].text
    assert.is_truthy(final:find("[[ref:par", 1, true))
    original.references = nil
    assert.is_truthy(settled(ns, original).parts[1].text:find("(reference unavailable)", 1, true))
end)

it("keeps HTML literal and never trusts model-supplied WoW markup", function()
    local _, ns = setup()
    local source =
        "<b>word</b> |Hspell:122|h[fake]|h\n\n```html\n<div>\nA|B\n---|---\nx|y\n</div>\n```"
    local view = settled(ns, message(source))
    assert.equal(0, #view.ui)
    local text = view.parts[1].text
    assert.is_truthy(text:find("<b>word</b>", 1, true))
    assert.is_truthy(text:find("||Hspell:122||h[fake]||h", 1, true))
    assert.is_truthy(view.parts[2].text:find("A||B", 1, true))
end)

it("does not reparse syntax for item data, references, resize or completion", function()
    local env, ns = setup()
    local original = message("[[ref:robe]] | State\n---|---\n**[[ref:robe]]** | partial")
    original.streaming = true
    local chat = { id = "chat", status = "working", messages = { original } }
    local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    local parse, calls = ns.Markdown.Parse, 0
    ns.Markdown.Parse = function(...)
        calls = calls + 1
        return parse(...)
    end
    ns.UI.RenderMessageRow(row, chat, original, 600, true)
    assert.equal(1, calls)
    local widget = row.rich.widgets.markdown_table_1
    original.references = { robe = { kind = "item", id = 100, label = "Toga" } }
    ns.UI.RenderMessageRow(row, chat, original, 210, false)
    assert.is_truthy(widget.tableRows[2].cells[1]:GetText():find("[Toga]", 1, true))
    original.references.robe.label = "New robe"
    env.GetItemIcon = function()
        return "LoadedIcon"
    end
    ns.itemRevision = ns.itemRevision + 1
    original.streaming, chat.status = false, "done"
    ns.UI.RenderMessageRow(row, chat, original, 600, true)
    assert.is_truthy(widget.tableRows[2].cells[1]:GetText():find("|TLoadedIcon:", 1, true))
    assert.is_truthy(widget.tableRows[2].cells[1]:GetText():find("[New robe]", 1, true))
    assert.equal(1, calls)
end)

it(
    "shows header-only tables, reuses streaming cells and retains the table after row twenty",
    function()
        local env, ns = setup()
        local original = message("| Piece | State |\n|---|---|\n")
        original.streaming = true
        local chat = { id = "chat", status = "working", messages = { original } }
        local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
        ns.UI.RenderMessageRow(row, chat, original, 210, true)
        local widget = row.rich.widgets.markdown_table_1
        assert.is_true(widget.tableRows[1]:IsShown())
        original.text = original.text .. "| To"
        ns.UI.RenderMessageRow(row, chat, original, 210, true)
        assert.equal("To", widget.tableRows[2].cells[1]:GetText())
        original.text = original.text .. "ga | Equi"
        ns.UI.RenderMessageRow(row, chat, original, 210, true)
        assert.equal("Equi", widget.tableRows[2].cells[2]:GetText())
        for _ = 1, 12 do
            original.text = original.text .. "x"
            ns.UI.RenderMessageRow(row, chat, original, 210, true)
        end
        assert.equal("Equi" .. string.rep("x", 12), widget.tableRows[2].cells[2]:GetText())
        original.text = original.text .. "|\n" .. string.rep("x|y\n", 24)
        settled(ns, original)
        ns.UI.RenderMessageRow(row, chat, original, 600, true)
        assert.equal(widget, row.rich.widgets.markdown_table_1)
        assert.equal("1-20 / 25", widget.pagerLabel:GetText())
        widget.pagerNext.scripts.OnClick()
        ns.UI.RenderMessageRow(row, chat, original, 600, true)
        assert.equal("21-25 / 25", widget.pagerLabel:GetText())
        assert.is_true(widget.tableRows[6]:IsShown())
        assert.is_false(widget.tableRows[7]:IsShown())
        assert.is_nil(original.ui)
        assert.is_nil(original.parts)
    end
)

it(
    "bounds table presentation by clipping cells and paginating rows instead of losing the layout",
    function()
        local _, ns = setup()
        local source = "A|B|C|D|E|F|G\n---|---|---|---|---|---|---\n"
            .. string.rep(string.rep("x", 350) .. "|2|3|4|5|6|7\n", 210)
        -- The display budget remains separate from the parser's generic input bound.
        source = source:sub(1, 60000)
        local view = settled(ns, message(source))
        assert.equal(1, #view.ui)
        assert.equal(6, #view.ui[1].columns)
        assert.is_truthy(view.ui[1].rows[1][1]:find("...", 1, true))
        assert.is_truthy(view.ui[1].notice:find("columns", 1, true))
        assert.is_true(#view.ui[1]._markdownRows <= 200)
    end
)

it(
    "processes a long response over steps and keeps a previously rendered table while updating",
    function()
        local env, ns = setup()
        local original = message("A|B\n---|---\nx|y")
        original.streaming = true
        local chat = { id = "chat", status = "working", messages = { original } }
        local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
        ns.UI.RenderMessageRow(row, chat, original, 600, true)
        local tableWidget = row.rich.widgets.markdown_table_1
        original.text = original.text
            .. "\n\n"
            .. string.rep("**dense** `literal` [label](https://example.com) ", 180)
        ns.UI.RenderMessageRow(row, chat, original, 600, true)
        local _, _, pending = ns.Markdown.Cache.Get(original.text)
        assert.is_true(pending)
        assert.equal(tableWidget, row.rich.widgets.markdown_table_1)
        assert.is_true(tableWidget:IsShown())
        assert.is_nil(row.rich.prose[1])
        settled(ns, original)
        ns.UI.RenderMessageRow(row, chat, original, 600, true)
        assert.is_true(tableWidget:IsShown())
        assert.is_truthy(row.rich.prose[1]:GetText():find("dense", 1, true))
    end
)

it("reveals streamed prose without cutting UTF-8 or remeasuring the row", function()
    local env, ns = setup()
    local original = message("")
    original.streaming = true
    local chat = { id = "chat", status = "working", messages = { original } }
    local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.is_nil(row.scripts.OnUpdate)
    original.text = "Ésta es una primera tanda de texto."
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    local height = row.height
    assert.equal("É", row.text:GetText())
    row.scripts.OnUpdate(row, 0.15)
    local partial = row.text:GetText()
    assert.is_true(#partial > #"É" and #partial < #original.text)
    assert.equal(height, row.height)

    original.text = original.text .. " Sigue la segunda."
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.equal(partial, row.text:GetText())
    row.scripts.OnUpdate(row, 0.4)
    assert.equal(original.text, row.text:GetText())
    assert.is_nil(row.scripts.OnUpdate)

    original.text = original.text .. "\n\nPárrafo nuevo."
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.equal("P", row.rich.prose[2]:GetText())
    original.streaming = false
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.equal("Párrafo nuevo.", row.rich.prose[2]:GetText())
    assert.is_nil(row.scripts.OnUpdate)
end)

it("preserves native markup and finishes the reveal when the row is hidden", function()
    local env, ns = setup()
    local original = message("**A bold start**")
    original.streaming = true
    local chat = { id = "chat", status = "working", messages = { original } }
    local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.equal("|cffe3c77eA bold start|r", row.text:GetText())
    assert.is_nil(row.scripts.OnUpdate)

    original.text = original.text .. "\n\nAnother paragraph."
    ns.UI.RenderMessageRow(row, chat, original, 210, true)
    assert.is_function(row.scripts.OnUpdate)
    row.scripts.OnHide(row)
    assert.equal("Another paragraph.", row.rich.prose[2]:GetText())
    assert.is_nil(row.scripts.OnUpdate)
end)

it("uses current metadata with a cached view and preserves user native links", function()
    local env, ns = setup()
    local original = message("A|B\n---|---\nx|y")
    original.ui = { { id = "action", kind = "button", label = "Continue" } }
    local chat = { id = "chat", status = "done", messages = { original } }
    local row = ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    local action
    ns.UI.PanelAction = function(_, current, node)
        action = { current.id, node.label }
    end
    ns.UI.RenderMessageRow(row, chat, original, 600, true)
    local tableWidget = row.rich.widgets.markdown_table_1
    original.id = "replacement"
    ns.UI.RenderMessageRow(row, chat, original, 600, true)
    assert.equal(tableWidget, row.rich.widgets.markdown_table_1)
    row.rich.widgets.action.control.scripts.OnClick()
    assert.same({ "replacement", "Continue" }, action)
    local link = "|cff71d5ff|Hspell:122:0|h[Nova]|h|r"
    ns.UI.RenderMessageRow(row, chat, { role = "user", text = link }, 600, true)
    assert.equal(link, row.text:GetText())
    assert.is_false(tableWidget:IsShown())
    assert.is_false(row.rich.widgets.action:IsShown())
end)
