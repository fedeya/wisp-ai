local helper = require("addon.tests.markdown-support")
local md = helper.parser()
local function paragraph(source, options)
    return assert(md.Parse(source, options)).children[1]
end

it("recognizes literal discs from older replies without changing inline or code text", function()
    local source =
        "Ventas:\n• **Grises**\n  • Tela\n• Equipo\n\n`• literal`\n\n```\n• código\n```"
    local tree = assert(md.Parse(source))
    local list = tree.children[2]
    assert.equal("list", list.type)
    assert.is_false(list.ordered)
    assert.equal(2, #list.children)
    assert.equal("Grises", helper.text(list.children[1].children[1]))
    assert.equal("list", list.children[1].children[2].type)
    assert.equal("Tela", helper.text(list.children[1].children[2]))
    assert.same({ { 2, 5 }, { 2, 14 } }, list.children[1].children[1].sourcepos)
    assert.equal("• literal", helper.text(tree.children[3]))
    assert.equal("• código\n", tree.children[4].literal)
    assert.equal("paragraph", paragraph("•sin espacio").type)
    assert.equal("paragraph", paragraph("Texto • intermedio").type)
end)

it("exposes only the Wisp parse and inline entry points", function()
    assert.is_function(md.Parse)
    assert.is_function(md.ParseInline)
    assert.is_nil(md.newStream)
    assert.is_nil(md.Node)
    local node, err = md.Parse("text", { dialect = "commonmark" })
    assert.is_nil(node)
    assert.same({ code = "invalid_option", option = "dialect" }, err)
end)

it("keeps code contents atomic inside strong text", function()
    local node = paragraph("**Use `a**b` now**")
    assert.equal("strong", node.children[1].type)
    assert.equal("code", node.children[1].children[2].type)
    assert.equal("a**b", node.children[1].children[2].literal)
    assert.equal("Use a**b now", helper.text(node))
end)

it("supports nested emphasis and both parts of triple emphasis", function()
    local node = paragraph("***one*** and **two _three_ four**")
    assert.equal("emph", node.children[1].type)
    assert.equal("strong", node.children[1].children[1].type)
    assert.equal("strong", node.children[3].type)
    assert.equal("emph", node.children[3].children[2].type)
    assert.equal("one and two three four", helper.text(node))
end)

it("preserves intraword underscores, escaped punctuation and unmatched markers", function()
    assert.equal(
        "snake_case foo_bar_baz *literal* **open",
        helper.text(paragraph("snake_case foo_bar_baz \\*literal* **open"))
    )
    assert.equal("a _b c_", helper.text(paragraph("*a _b* c_")))
end)

it("renders strike spans with nested emphasis while single tildes stay literal", function()
    local node = paragraph("~~old **bold**~~ ~literal~")
    assert.equal("strikethrough", node.children[1].type)
    assert.equal("strong", node.children[1].children[2].type)
    assert.equal("old bold ~literal~", helper.text(node))
end)

it("matches code delimiters by length and preserves code escapes and references", function()
    local node = paragraph("`` a`b `` `[[ref:item]]` \\``x`", { references = true })
    assert.equal("code", node.children[1].type)
    assert.equal("a`b", node.children[1].literal)
    assert.equal("[[ref:item]]", node.children[3].literal)
    assert.equal("code", node.children[5].type)
    assert.equal("x", node.children[5].literal)
end)

it("parses links without interpreting their destinations as emphasis", function()
    local node = paragraph('[**label**](https://example.com/a**b "title")')
    local link = node.children[1]
    assert.equal("link", link.type)
    assert.equal("https://example.com/a**b", link.destination)
    assert.equal("title", link.title)
    assert.equal("strong", link.children[1].type)
    assert.equal("label", helper.text(link))
end)

it("handles balanced destinations, angle destinations, images and autolinks", function()
    local node = paragraph(
        "[a](a(b)c) [b](<some path>) ![alt _name_](https://x/p.png) <https://example.com>"
    )
    assert.equal("a(b)c", node.children[1].destination)
    assert.equal("some path", node.children[3].destination)
    assert.equal("image", node.children[5].type)
    assert.equal("alt name", helper.text(node.children[5]))
    assert.equal("https://example.com", node.children[7].destination)
end)

it("collects late reference definitions and preserves the first definition", function()
    local node = paragraph(
        '[TÍTULO][] [name]\n\n[título]: /first "caption"\n[título]: /later\n[name]: /name'
    )
    assert.equal("/first", node.children[1].destination)
    assert.equal("caption", node.children[1].title)
    assert.equal("/name", node.children[3].destination)
end)

it("recognizes complete and incomplete Wisp references outside code", function()
    local node =
        paragraph("**[[ref:spell_1]]** `[[ref:literal]]` [[ref:spell", { references = true })
    assert.equal("reference", node.children[1].children[1].type)
    assert.equal("spell_1", node.children[1].children[1].key)
    assert.equal("code", node.children[3].type)
    assert.equal("reference_pending", node.children[5].type)
    assert.equal("[[ref:spell", node.children[5].literal)
    assert.equal("text", paragraph("[[ref:spell]]").children[1].type)
    assert.equal("text", paragraph("[").children[1].type)
end)

it("treats raw HTML as literal text and only decodes basic or numeric entities", function()
    local node = paragraph("<button x='y'>**word**</button> &amp; &#124; &#x1f600; &unknown;")
    assert.equal("html_inline", node.children[1].type)
    assert.equal("<button x='y'>", node.children[1].literal)
    assert.equal("<button x='y'>word</button> & | 😀 &unknown;", helper.text(node))
end)

it("preserves soft and hard breaks without losing inline whitespace", function()
    local node = assert(md.ParseInline("  first\nsecond  \nthird\\\nfourth  "))
    assert.equal("softbreak", node.children[2].type)
    assert.equal("linebreak", node.children[4].type)
    assert.equal("linebreak", node.children[6].type)
    assert.equal("  first\nsecond\nthird\nfourth  ", helper.text(node))
end)

it("uses array children and preserves nested table source positions", function()
    local doc = assert(md.Parse("> | A | B |\n> |---|---:|\n> |x|**y**|\n"))
    local tab = doc.children[1].children[1]
    assert.equal("table", tab.type)
    assert.equal(true, tab.children[1].header)
    assert.equal("right", tab.align[2])
    assert.equal("strong", tab.children[2].children[2].children[1].type)
    assert.equal(1, tab.sourcepos[1][1])
    assert.equal(3, tab.sourcepos[2][1])
    assert.is_nil(tab.firstChild)
    assert.is_nil(tab.parent)
end)

it("normalizes CRLF, CR, NUL and malformed UTF-8", function()
    local doc = assert(md.Parse("ñ\r\n😀\rzero\0bad\255"))
    assert.equal("ñ\n😀\nzero�bad�", helper.text(doc))
    assert.equal(3, doc.children[1].sourcepos[2][1])
end)

it("does not modify source options or prior documents when resolving definitions", function()
    local source, options = "[x]", { references = true }
    local first = assert(md.Parse(source, options))
    local before = helper.text(first)
    local second = assert(md.Parse(source .. "\n\n[x]: /resolved", options))
    assert.same({ references = true }, options)
    assert.equal(before, helper.text(first))
    assert.equal("text", first.children[1].children[1].type)
    assert.equal("link", second.children[1].children[1].type)
end)

it("rejects invalid input and unsupported options with structured errors", function()
    for _, source in ipairs({ false, 1, {} }) do
        local doc, err = md.Parse(source)
        assert.is_nil(doc)
        assert.equal("invalid_source", err.code)
    end
    for _, options in ipairs({
        false,
        "gfm",
        { references = "yes" },
        { dialect = "gfm" },
        { maxBytes = 0 },
        { maxNodes = false },
        { maxNesting = 1.5 },
        { maxBytes = math.huge },
    }) do
        local doc, err = md.Parse("x", options)
        assert.is_nil(doc)
        assert.is_table(err)
    end
end)

it("enforces byte, allocation and syntax-depth limits atomically", function()
    for _, example in ipairs({
        { "abcdef", { maxBytes = 5 }, "max_bytes" },
        { "**x**", { maxNodes = 2 }, "max_nodes" },
        { "> > > x", { maxNesting = 1 }, "max_nesting" },
        { "[x](a(b(c)d)e)", { maxNesting = 1 }, "max_nesting" },
        { "***x***", { maxNesting = 1 }, "max_nesting" },
    }) do
        local doc, err = md.Parse(example[1], example[2])
        assert.is_nil(doc)
        assert.equal(example[3], err.code)
        assert.is_nil(err.markdownLimit)
    end
end)

it("keeps mixed malformed syntax bounded and returns valid acyclic trees", function()
    local seed = 1139
    local pieces = {
        "*",
        "**",
        "_",
        "~~",
        "[",
        "]",
        "(",
        ")",
        "`",
        "\\",
        "!",
        "<b>",
        ">",
        "ñ",
        "😀",
        "x",
        "\n",
        "|",
        "&amp;",
    }
    for _ = 1, 500 do
        local source = {}
        for _ = 1, 35 do
            seed = (seed * 16807) % 2147483647
            source[#source + 1] = pieces[seed % #pieces + 1]
        end
        local doc = assert(md.Parse(table.concat(source), { references = true }))
        local pending, seen = { doc }, {}
        while #pending > 0 do
            local node = table.remove(pending)
            assert.is_nil(seen[node])
            seen[node] = true
            assert.is_string(node.type)
            assert.is_table(node.children)
            for _, child in ipairs(node.children) do
                pending[#pending + 1] = child
            end
            assert.is_nil(node._inline)
        end
    end
end)

it("keeps native WoW hyperlinks opaque including quality colors and Markdown in labels", function()
    local links = {
        "|cnIQ2:|Hitem:100:0:0|h[Name **with MD**]|h|r",
        "|cff9d9d9d|Hitem:100:0:0|h[Name _with MD_]|h|r",
        "|Hspell:122|h[Name [[ref:key]]]|h",
    }
    for _, link in ipairs(links) do
        local label = assert(md.ParseInline("Before " .. link .. " after", { references = true }))
        assert.equal(3, #label.children)
        assert.equal("native_link", label.children[2].type)
        assert.equal(link, label.children[2].literal)
        assert.same({}, label.children[2].children)
        assert.equal("Before " .. link .. " after", helper.text(label))
    end
end)

it("keeps native hyperlinks inside code literal and leaves malformed links as text", function()
    local link = "|cff71d5ff|Hspell:122|h[Name **literal**]|h|r"
    local label = assert(md.ParseInline("`" .. link .. "`"))
    assert.equal("code", label.children[1].type)
    assert.equal(link, label.children[1].literal)
    for _, source in ipairs({
        "|Hitem:100|h[unfinished]",
        "|Hitem:100|h[Name\nsplit]|h",
        "|H|h[No payload]|h",
    }) do
        local node = assert(md.ParseInline(source))
        assert.equal(source, helper.text(node))
        for _, child in ipairs(node.children) do
            assert.not_equal("native_link", child.type)
        end
    end
end)

it("applies normal parser limits to native hyperlink leaves", function()
    local source = "|Hitem:100|h[Name]|h"
    local node, err = md.ParseInline(source, { maxBytes = #source - 1 })
    assert.is_nil(node)
    assert.equal("max_bytes", err.code)
    node, err = md.ParseInline(source, { maxNodes = 1 })
    assert.is_nil(node)
    assert.equal("max_nodes", err.code)
    node = assert(md.ParseInline(source, { maxNodes = 2 }))
    assert.equal("native_link", node.children[1].type)
end)
