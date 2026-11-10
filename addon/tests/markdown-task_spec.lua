local helper = require("addon.tests.markdown-support")
local md = helper.parser()
local function finish(task)
    local resumes = 0
    while true do
        resumes = resumes + 1
        local ok, value, err = coroutine.resume(task)
        if not ok then
            return nil, value, resumes
        end
        if coroutine.status(task) == "dead" then
            return value, err, resumes
        end
        assert.is_nil(value)
        assert.is_nil(err)
        assert.is_true(resumes < 100000)
    end
end
it("cooperatively builds the same document as synchronous parsing", function()
    local source = "# Guide\n\n"
        .. string.rep(
            "**bold _word_** and `code` [label](https://example.com/a(b)) [[ref:spell]].\n",
            150
        )
        .. "\n| A | B |\n|---|---|\n| x | y |\n\n[x]: /late\n"
    local options = { references = true }
    local document, err, count = finish(md._newTask(source, options, false))
    assert.is_nil(err)
    assert.is_true(count > 1)
    assert.same(assert(md.parse(source, options)), document)
end)
it("cooperatively parses inline labels while preserving their whitespace", function()
    local source = "  " .. string.rep("**x** _y_ `z` ", 80) .. "  "
    local document, err, count = finish(md._newTask(source, {}, true))
    assert.is_nil(err)
    assert.is_true(count > 1)
    assert.same(assert(md.parseInline(source)), document)
end)
it("captures task options and reports resource failures without a partial tree", function()
    local options = { maxNodes = 5 }
    local task = md._newTask(string.rep("**x** ", 200), options)
    options.maxNodes = 10000
    local document, err = finish(task)
    assert.is_nil(document)
    assert.equal("max_nodes", err.code)
    assert.is_true(err.markdownLimit)
    document, err = finish(md._newTask("long", { maxBytes = 2 }))
    assert.is_nil(document)
    assert.equal("max_bytes", err.code)
end)
it("isolates abandoned tasks from a newer parse of the same source", function()
    local source = string.rep("[text](https://example.com) **word**\n", 200)
    local old = md._newTask(source)
    assert(coroutine.resume(old))
    assert.equal("suspended", coroutine.status(old))
    local newer = assert(md.parse("# New source"))
    assert.equal("heading", newer.children[1].type)
    local oldResult = assert(finish(old))
    assert.equal("paragraph", oldResult.children[1].type)
    assert.equal("heading", newer.children[1].type)
end)
