local helper = require("addon.tests.fixtures.markdown.support")
local markdown = helper.parser()

for _, example in ipairs(require("addon.tests.fixtures.markdown.commonmark")) do
    it("CommonMark 0.31.2 #" .. example.id .. " " .. example.section, function()
        local document, err = markdown.parse(example.markdown, { dialect = "commonmark" })
        assert(document, err and err.code)
        assert.are.equal(example.html, helper.html(document), example.markdown)
    end)
end

for _, fixture in ipairs({ "gfm", "gfm-additional" }) do
    for _, example in ipairs(require("addon.tests.fixtures.markdown." .. fixture)) do
        it(fixture .. " #" .. example.id .. " " .. example.section, function()
            local document, err = markdown.parse(example.markdown)
            assert(document, err and err.code)
            if not example.checkOnly then
                assert.are.equal(
                    helper.canonicalHTML(example.html),
                    helper.canonicalHTML(helper.html(document)),
                    example.markdown
                )
            end
        end)
    end
end
