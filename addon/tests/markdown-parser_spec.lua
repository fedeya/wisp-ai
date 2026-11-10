local helper = require("addon.tests.fixtures.markdown.support")
local markdown = helper.parser()

local function literal(root)
    local pieces = {}
    for node, entering in root:walker() do
        if entering and node.literal then
            pieces[#pieces + 1] = node.literal
        end
    end
    return table.concat(pieces)
end

local function validTree(root)
    local seen = {}
    assert.is_nil(root.parent)
    for node, entering in root:walker() do
        if entering then
            assert.is_nil(seen[node], "a node is visited twice")
            seen[node] = true
            for key in pairs(node) do
                assert.not_equal("_", key:sub(1, 1), "private parse state escapes into the AST")
            end
            if node.next then
                assert.equal(node, node.next.prev)
                assert.equal(node.parent, node.next.parent)
            end
            if node.prev then
                assert.equal(node, node.prev.next)
            end
            local previous, child = nil, node.firstChild
            while child do
                assert.equal(node, child.parent)
                assert.equal(previous, child.prev)
                previous, child = child, child.next
            end
            assert.equal(previous, node.lastChild)
        end
    end
end

it("keeps code and destinations atomic while resolving surrounding emphasis", function()
    local document =
        assert(markdown.parse("**Use `a**b` now** and **a [b](https://example.com/a**b) c**"))
    assert.equal(
        '<p><strong>Use <code>a**b</code> now</strong> and <strong>a <a href="https://example.com/a**b">b</a> c</strong></p>\n',
        helper.html(document)
    )
    validTree(document)
end)

it("recognizes the remaining backticks after an escaped run prefix", function()
    assert.equal("<p>`<code>x</code></p>\n", helper.html(assert(markdown.parse("\\``x`"))))
    assert.equal("<p>`<code>x</code></p>\n", helper.html(assert(markdown.parse("\\```x``"))))
end)

it("exposes an explicit CommonMark dialect without GFM extensions", function()
    local source = "A | B\n---|---\nx | y\n\n~~old~~ www.example.com\n\n- [x] done"
    local gfm = assert(markdown.parse(source))
    local commonmark = assert(markdown.parse(source, { dialect = "commonmark" }))
    assert.equal("table", gfm.firstChild.type)
    assert.equal("paragraph", commonmark.firstChild.type)
    assert.is_truthy(helper.html(commonmark):find("~~old~~ www.example.com", 1, true))
    assert.is_falsy(commonmark.lastChild.firstChild.task)
    assert.is_true(gfm.lastChild.firstChild.checked)
end)

it("recognizes Wisp references only when enabled and preserves their exact keys", function()
    local document = assert(
        markdown.parse(
            "**[[ref:spell_1]]** `[[ref:literal]]` \\[[ref:escaped]]",
            { references = true }
        )
    )
    local reference = document.firstChild.firstChild.firstChild
    assert.equal("reference", reference.type)
    assert.equal("spell_1", reference.key)
    assert.equal("[[ref:spell_1]]", reference.literal)
    local count = 0
    for node in document:walker() do
        if node.type == "reference" then
            count = count + 1
        end
    end
    assert.equal(1, count)
    assert.equal("text", assert(markdown.parseInline("[[ref:spell_1]]")).firstChild.type)
    validTree(document)
end)

it("preserves whitespace in the standalone inline API", function()
    local inline = assert(markdown.parseInline("  a *b*  "))
    assert.equal("  a b  ", literal(inline))
    assert.equal("paragraph", inline.type)
    validTree(inline)
end)

it("uses full Unicode case folding for reference labels", function()
    local document = assert(markdown.parse("[Straße] [Σ] [ς]\n\n[STRASSE]: /a\n[σ]: /b"))
    assert.equal(
        '<p><a href="/a">Straße</a> <a href="/b">Σ</a> <a href="/b">ς</a></p>\n',
        helper.html(document)
    )
    assert.equal("16.0.0", markdown.Data.unicodeVersion)
end)

it("uses CommonMark whitespace categories and ASCII grammar independently of locale", function()
    for _, code in ipairs({
        9,
        10,
        12,
        13,
        32,
        0xA0,
        0x1680,
        0x2000,
        0x200A,
        0x202F,
        0x205F,
        0x3000,
    }) do
        assert.is_true(markdown.Scanner.whitespace(code))
    end
    for _, code in ipairs({ 11, 0x85, 0x2028, 0x2029, 0xFEFF }) do
        assert.is_false(markdown.Scanner.whitespace(code))
        assert.equal(
            "emph",
            assert(markdown.parseInline("*" .. markdown.Scanner.char(code) .. "x*")).firstChild.type
        )
    end
    assert.is_nil(
        helper.html(assert(markdown.parse("é@ñ.com <é@example.com>"))):find("<a ", 1, true)
    )
    local document = assert(markdown.parse("[x](/a\001b) [x](/a\127b)"))
    assert.is_nil(helper.html(document):find("<a ", 1, true))
end)

it("classifies astral symbols as whole Unicode scalars when flanking delimiters", function()
    local document = assert(markdown.parse("***# 😀**https://x.y", { dialect = "commonmark" }))
    assert.equal("<p>***# 😀**https://x.y</p>\n", helper.html(document))
    document = assert(markdown.parse("😀*||:_b***", { dialect = "commonmark" }))
    assert.equal("<p>😀<em>||:_b</em>**</p>\n", helper.html(document))
end)

it("bounds reference labels by original Unicode characters before case folding", function()
    local valid = string.rep("é", 999)
    local document = assert(markdown.parse("[" .. valid .. "]\n\n[" .. valid .. "]: /ok"))
    assert.equal("link", document.firstChild.firstChild.type)
    local long = string.rep("s", 1000)
    document =
        assert(markdown.parse("[" .. long .. "]\n\n[" .. string.rep("ß", 500) .. "]: /wrong"))
    assert.is_nil(helper.html(document):find("<a ", 1, true))
end)

it("decodes the complete HTML entity map and keeps entity text out of syntax", function()
    local document = assert(
        markdown.parse(
            "&NotEqualTilde; &CounterClockwiseContourIntegral; &#x1F600; &#0; &ast;x&ast;"
        )
    )
    assert.equal("≂̸ ∳ 😀 � *x*", literal(document))
    assert.equal("text", document.firstChild.firstChild.type)
end)

it("normalizes line endings, NUL and malformed UTF-8 without host APIs", function()
    local document = assert(markdown.parse("a\r\nb\rc\000\255\237\160\128"))
    assert.equal("<p>a\nb\nc�����</p>\n", helper.html(document))
end)

it("keeps raw HTML opaque instead of interpreting its contents as Markdown", function()
    local document = assert(markdown.parse("<script>\n**raw**\n</script>\n\nAfter"))
    assert.equal("html_block", document.firstChild.type)
    assert.equal("<script>\n**raw**\n</script>", document.firstChild.literal)
    assert.is_nil(document.firstChild.firstChild)
end)

it("retains source ranges when a table interrupts a paragraph", function()
    local document = assert(
        markdown.parse("Long preceding line\n  | A | B |\n  |---|---|\n  | ñ | x |\n\nAfter")
    )
    local paragraph, tableNode = document.firstChild, document.firstChild.next
    assert.same({ { 1, 1 }, { 1, 19 } }, paragraph.sourcepos)
    assert.same({ { 2, 3 }, { 4, 12 } }, tableNode.sourcepos)
    assert.same({ { 2, 3 }, { 2, 11 } }, tableNode.firstChild.firstChild.sourcepos)
    assert.equal("table", tableNode.type)
    assert.equal("After", literal(tableNode.next))
end)

it("accepts empty and single-column table headers independently of UI limits", function()
    local document = assert(markdown.parse("| |\n|-|"))
    assert.equal("table", document.firstChild.type)
    assert.equal(1, #document.firstChild.align)
    assert.is_nil(document.firstChild.firstChild.firstChild.firstChild.firstChild)
    assert.is_nil(document.firstChild.firstChild.next)
    validTree(document)
end)

it("distinguishes odd and even backslash runs before table pipes", function()
    local cells = markdown.Extensions.cells
    assert.same({ "a|b", "c" }, cells("a\\|b | c"))
    assert.same({ "a\\\\", "b", "c" }, cells("a\\\\|b | c"))
    assert.same({ "a\\\\|b", "c" }, cells("a\\\\\\|b | c"))
    local document = assert(markdown.parse("A | B\n---|---\n`x\\|y` | z"))
    assert.is_truthy(helper.html(document):find("<code>x|y</code>", 1, true))
end)

it("closes tables at new block structures and supports tables in containers", function()
    for _, block in ipairs({
        "# heading",
        "> quote",
        "- item",
        "```\ncode\n```",
        "<div>raw</div>",
        "---",
    }) do
        local document = assert(markdown.parse("A|B\n-|-\nx|y\n" .. block))
        assert.equal("table", document.firstChild.type)
        assert.is_truthy(document.firstChild.next, block)
    end
    local document =
        assert(markdown.parse("> | A | B |\n> |---|---|\n> | x | y |\n\n- A | B\n  - | -\n  x | y"))
    assert.equal("table", document.firstChild.firstChild.type)
    assert.equal("table", document.lastChild.firstChild.firstChild.type)
    validTree(document)
end)

it("resolves table references declared later without mutating earlier parses", function()
    local source = "A | B\n---|---\n[x] | [[ref:s]]"
    local first = assert(markdown.parse(source, { references = true }))
    local before = helper.html(first)
    local second = assert(markdown.parse(source .. "\n\n[x]: /later", { references = true }))
    assert.equal(before, helper.html(first))
    assert.is_truthy(helper.html(second):find('<a href="/later">x</a>', 1, true))
end)

it("resets URL lookahead state between paragraphs", function()
    local document = assert(
        markdown.parse("www.example.com.\n\nwww.example.com/path.\n\nwww.a._b.c\n\nwww.example.com")
    )
    assert.equal(3, select(2, helper.html(document):gsub("<a href=", "")))
    assert.is_truthy(helper.html(document):find('href="http://www.example.com/path"', 1, true))
end)

it("rejects invalid options with structured errors", function()
    for _, options in ipairs({
        false,
        1,
        "gfm",
        { dialect = "other" },
        { dialect = false },
        { maxBytes = false },
        { maxNodes = 0 },
        { maxNesting = 1.5 },
        { maxBytes = math.huge },
        { references = "yes" },
    }) do
        local document, err = markdown.parse("x", options)
        assert.is_nil(document)
        assert.is_table(err)
        assert.is_string(err.code)
    end
    local document, err = markdown.parse({})
    assert.is_nil(document)
    assert.equal("invalid_source", err.code)
end)

it("enforces byte, node and container-depth budgets without returning truncated trees", function()
    for _, example in ipairs({
        { "abcdef", { maxBytes = 5 }, "max_bytes" },
        { "*x*", { maxNodes = 3 }, "max_nodes" },
        { string.rep("> ", 20) .. "x", { maxNesting = 8 }, "max_nesting" },
        {
            "[x](" .. string.rep("(", 20) .. "x" .. string.rep(")", 20) .. ")",
            { maxNesting = 8 },
            "max_nesting",
        },
    }) do
        local document, err = markdown.parse(example[1], example[2])
        assert.is_nil(document)
        assert.equal(example[3], err.code)
    end
    assert.is_table(markdown.parse("abc", { maxBytes = 3, maxNodes = 3, maxNesting = 1 }))
end)

it("parses deterministic mixed-input fuzz cases into structurally valid trees", function()
    local seed = 9173
    local symbols = {
        "*",
        "_",
        "~",
        "\\",
        "[",
        "]",
        "(",
        ")",
        "`",
        "<",
        ">",
        " ",
        "\t",
        "\n",
        "&",
        ";",
        ":",
        "!",
        "x",
        "0",
        "|",
        "😀",
        "ñ",
        "你好",
        "http://",
        "www.",
        "[[ref:x]]",
    }
    for _ = 1, 1200 do
        local pieces = {}
        for _ = 1, 60 do
            seed = seed * 16807 % 2147483647
            pieces[#pieces + 1] = symbols[seed % #symbols + 1]
        end
        local document, err = markdown.parse(table.concat(pieces), { references = true })
        assert(document, err and err.code)
        validTree(document)
    end
end)

it("handles long lines, unmatched runs, nested emphasis and invalid domains promptly", function()
    local ticks = {}
    for i = 1, 220 do
        ticks[#ticks + 1] = string.rep("`", i) .. "x "
    end
    local inputs = {
        string.rep("a", 40000),
        table.concat(ticks),
        string.rep("*", 12000) .. "x" .. string.rep("*", 12000),
        string.rep("![", 1500) .. string.rep("[x](u)", 1500),
        string.rep("www._", 6000),
        "http://a.b/" .. string.rep("*", 30000),
        "x " .. string.rep("<? ", 8000) .. ">",
    }
    local started = os.clock()
    for _, source in ipairs(inputs) do
        validTree(assert(markdown.parse(source)))
    end
    assert.is_true(os.clock() - started < 8, "adversarial inputs exceeded the generous CPU budget")
end)
