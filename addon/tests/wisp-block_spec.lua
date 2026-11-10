-- Focused contract tests for Wisp's independently implemented block grammar.
-- Run from the repository root with Lua 5.1.
local function runblocks()
    local C = { Markdown = {} }
    assert(loadfile("addon/WispAI/Markdown/Block.lua"))("WispAI", C)
    local checks, checkpoints = 0, 0
    local function equal(actual, expected, message)
        checks = checks + 1
        assert(
            actual == expected,
            (message or "value")
                .. ": expected "
                .. tostring(expected)
                .. ", got "
                .. tostring(actual)
        )
    end
    local function parse(source, options)
        local context = {
            options = options or {},
            references = {},
            checkpoint = function()
                checkpoints = checkpoints + 1
            end,
            referenceLabel = function(label)
                return (label:lower():gsub("%s+", " "):gsub("^ +", ""):gsub(" +$", ""))
            end,
            node = function(kind, fields)
                fields.type = kind
                return fields
            end,
        }
        return C.Markdown._blocks(source, context), context
    end

    local doc = parse("hello\nworld\n\n# Title #\n\nA\n===\n\n- - -\n")
    equal(#doc.children, 4)
    equal(doc.children[1]._inline, "hello\nworld")
    equal(doc.children[2].type, "heading")
    equal(doc.children[2]._inline, "Title")
    equal(doc.children[3].level, 1)
    equal(doc.children[3].sourcepos[2][1], 7)
    equal(doc.children[4].type, "thematic_break")
    equal(parse("# ###").children[1]._inline, "")
    equal(parse("####### prose").children[1].type, "paragraph")

    doc = parse("  ```lua\n  one\n two\n  ````\n\n    code\n\n    next\n\nend")
    equal(doc.children[1].type, "code_block")
    equal(doc.children[1].info, "lua")
    equal(doc.children[1].literal, "one\ntwo\n")
    equal(doc.children[1].sourcepos[1][2], 3)
    equal(doc.children[1].sourcepos[2][1], 4)
    equal(doc.children[2].literal, "code\n\nnext\n")
    equal(doc.children[3]._inline, "end")
    equal(parse("```\n\tcode\n```").children[1].literal, "\tcode\n")
    equal(parse("~~~ lang\ncode").children[1].literal, "code\n")

    doc = parse("- first\n  - inner\n  - again\n- second\n\n  paragraph\n\noutside")
    local list = doc.children[1]
    equal(list.type, "list")
    equal(list.ordered, false)
    equal(list.tight, false)
    equal(#list.children, 2)
    equal(list.children[1].children[2].type, "list")
    equal(list.children[1].children[2].children[2].children[1]._inline, "again")
    equal(list.children[2].children[2]._inline, "paragraph")
    equal(list.children[2].sourcepos[1][1], 4)
    equal(list.children[2].sourcepos[2][1], 6)
    equal(doc.children[2]._inline, "outside")
    doc = parse("2. two\n3. three\n\n- [x] done\n- [ ] todo\n- ordinary")
    equal(doc.children[1].ordered, true)
    equal(doc.children[1].start, 2)
    equal(doc.children[1].tight, true)
    equal(doc.children[2].children[1].checked, true)
    equal(doc.children[2].children[2].checked, false)
    equal(doc.children[2].children[3].checked, nil)
    equal(doc.children[2].children[1].children[1]._inline, "done")
    equal(parse("-\ttext").children[1].children[1].children[1]._inline, "text")
    equal(#parse("- # heading\noutside").children, 2)
    equal(parse("- first\nlazy").children[1].children[1].children[1]._inline, "first\nlazy")
    equal(#parse("-     code\noutside").children, 2)
    equal(#parse("- a\n  ===\noutside").children, 2)
    equal(#parse("- ```\n  code\noutside").children, 2)
    equal(#parse("- | h |\n  | --- |\n  | body |\noutside").children, 2)
    equal(parse("- a\n  - b\n\n  - c\n- d").children[1].tight, true)
    equal(parse("- ```\n  a\n\n  b\n  ```\n- d").children[1].tight, true)

    doc = parse("> quote\nlazy\n>\n> - item\n>   continuation\n\nafter")
    equal(doc.children[1].type, "block_quote")
    equal(doc.children[1].children[1]._inline, "quote\nlazy")
    equal(doc.children[1].children[2].children[1].children[1]._inline, "item\ncontinuation")
    equal(doc.children[1].children[2].sourcepos[1][1], 4)
    equal(doc.children[1].children[2].children[1].children[1].sourcepos[1][2], 5)
    equal(doc.children[2]._inline, "after")
    equal(#parse("> ```\n> code\noutside").children, 2)
    equal(#parse("> | h |\n> | --- |\n> | body |\noutside").children, 2)
    equal(#parse("> | h |\n> ---\n> body\noutside").children, 2)

    local context
    doc, context = parse(
        "[  Label  ]: <https://example.test/a> \"A title\"\n[label]: other\n\n[label]\n\n[second]: /path\n  'next title'"
    )
    equal(#doc.children, 1)
    equal(doc.children[1]._inline, "[label]")
    equal(context.references.label.destination, "https://example.test/a")
    equal(context.references.label.title, "A title")
    equal(context.references.second.title, "next title")

    doc = parse(
        "| Left | Center | Right | Plain |\n| :--- | :---: | ---: | --- |\n| a | b | c | d | extra |\n| short |\n\nnext"
    )
    local tab = doc.children[1]
    equal(tab.type, "table")
    equal(#tab.children, 3)
    equal(tab.align[1], "left")
    equal(tab.align[2], "center")
    equal(tab.align[3], "right")
    equal(tab.align[4], false)
    equal(tab.children[1].header, true)
    equal(tab.children[2].header, false)
    equal(#tab.children[2].children, 4)
    equal(tab.children[3].children[2]._inline, "")
    equal(tab.sourcepos[2][1], 4)
    equal(doc.children[2]._inline, "next")
    doc = parse("| `a\\|b` | c\\|d |\n| --- | --- |")
    equal(doc.children[1].children[1].children[1]._inline, "`a|b`")
    equal(doc.children[1].children[1].children[2]._inline, "c|d")
    equal(#doc.children[1].children, 1)
    equal(parse("| one |\n| --- |").children[1].type, "table")
    equal(parse("one\n---").children[1].type, "heading")
    doc = parse("> - | A | B |\n>   | --- | --- |\n>   | c | d |")
    tab = doc.children[1].children[1].children[1].children[1]
    equal(tab.type, "table")
    equal(tab.children[2].children[1]._inline, "c")
    equal(tab.sourcepos[1][1], 1)
    equal(tab.sourcepos[2][1], 3)

    local ok, reason = pcall(parse, "> > > content", { maxNesting = 1 })
    equal(ok, false)
    equal(type(reason), "table")
    equal(reason.markdownLimit, true)
    equal(reason.code, "max_nesting")
    equal(reason.limit, 1)
    doc = parse("a\r\nb\rc\n")
    equal(doc.children[1]._inline, "a\nb\nc")
    equal(doc.sourcepos[2][1], 3)
    equal(parse("").sourcepos[2][2], 1)
    equal(parse("<button>literal</button>").children[1]._inline, "<button>literal</button>")
    parse(string.rep("paragraph\n\n", 100))
    assert(checkpoints > 0, "the block parser must cooperate")
    local yields = 0
    local thread = coroutine.create(function()
        return C.Markdown._blocks(string.rep("- item\n", 80), {
            options = {},
            references = {},
            checkpoint = function()
                yields = yields + 1
                coroutine.yield()
            end,
            node = function(kind, fields)
                fields.type = kind
                return fields
            end,
        })
    end)
    while coroutine.status(thread) ~= "dead" do
        assert(coroutine.resume(thread))
    end
    assert(yields > 0, "checkpoints must be yieldable on Lua 5.1")
    if type(it) ~= "function" then
        print("wisp-block: " .. checks .. " assertions passed")
    end
end

if type(it) == "function" then
    it("parses Wisp block constructs with original source positions", runblocks)
else
    runblocks()
end
