local helper = require("addon.tests.markdown-support")
local md = helper.parser()

local function paragraph(source)
    return assert(md.parse(source)).children[1]
end

local function count(node, kind)
    local total = node.type == kind and 1 or 0
    for _, child in ipairs(node.children) do
        total = total + count(child, kind)
    end
    return total
end

it("finds an earlier compatible bold opener around an intraword asterisk", function()
    for _, source in ipairs({ "**2*3=6**", "**2\\*3=6**", "**a*b**" }) do
        local node = paragraph(source).children[1]
        assert.equal("strong", node.type)
        assert.equal(source:find("2", 1, true) and "2*3=6" or "a*b", helper.text(node))
    end
    local node = paragraph("**Use `2*3=6` now**").children[1]
    assert.equal("strong", node.type)
    assert.equal("code", node.children[2].type)
    assert.equal("2*3=6", node.children[2].literal)
end)

it("retains an incompatible candidate for a later compatible closer", function()
    local node = paragraph("a*b c**d e*f")
    assert.equal("a", node.children[1].literal)
    assert.equal("emph", node.children[2].type)
    assert.equal("b c**d e", helper.text(node.children[2]))
    assert.equal("f", node.children[3].literal)
end)

it("normalizes escaped and entity reference labels once on both paths", function()
    local node = paragraph("[A\\*B] [shown][a\\*b] [a\\*b][]\n\n[a\\*b]: /url")
    for _, index in ipairs({ 1, 3, 5 }) do
        assert.equal("link", node.children[index].type)
        assert.equal("/url", node.children[index].destination)
    end
    assert.equal("A*B", helper.text(node.children[1]))
    local entity = paragraph("[a&#42;b]\n\n[a&#42;b]: /entity").children[1]
    assert.equal("link", entity.type)
    assert.equal("/entity", entity.destination)
    local escaped =
        paragraph("[double][a\\\\*b] [single][a\\*b]\n\n[a\\\\*b]: /double\n[a\\*b]: /single")
    assert.equal("/double", escaped.children[1].destination)
    assert.equal("/single", escaped.children[3].destination)
end)

it("preserves images and formatted alt text inside a link label", function()
    local link = paragraph("[![**alt**](image.png)](https://outer)").children[1]
    assert.equal("link", link.type)
    assert.equal("https://outer", link.destination)
    assert.equal("image", link.children[1].type)
    assert.equal("image.png", link.children[1].destination)
    assert.equal("strong", link.children[1].children[1].type)
    assert.equal("alt", helper.text(link))
end)

it("does not turn explicit or angle links into nested links", function()
    for _, source in ipairs({
        "[outer [inner](inside)](outside)",
        "[outer <https://inner>](outside)",
        "[outer [inner][r]](outside)\n\n[r]: /inside",
    }) do
        local link = paragraph(source).children[1]
        assert.equal("link", link.type)
        assert.equal("outside", link.destination)
        assert.equal(1, count(link, "link"))
    end
    assert.equal("link", paragraph("<https://inner>").children[1].type)
end)

it("keeps incompatible-opener scanning bounded while matching ordinary spans", function()
    local function work(size)
        local source = string.rep("*a ", size) .. string.rep("a**b ", size)
        local task = md._newTask(source)
        local steps = 0
        while true do
            local ok, document, err = coroutine.resume(task)
            assert.is_true(ok, document)
            steps = steps + 1
            if coroutine.status(task) == "dead" then
                assert.is_nil(err)
                assert.same(assert(md.parse(source)), document)
                return steps
            end
        end
    end
    local small, large = work(100), work(200)
    assert.is_true(large <= small * 3, "doubling input must not quadruple delimiter work")
end)
