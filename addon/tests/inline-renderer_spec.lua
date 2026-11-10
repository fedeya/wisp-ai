local helper = require("addon.tests.support")

it("returns explicit pending status for plain, synchronous, pending and cached text", function()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.C = {}
    helper.addon("UI.lua", env)
    local C = env.C

    local text, pending = C.FormatText("Plain text")
    assert.equal("Plain text", text)
    assert.is_false(pending)
    text, pending = C.FormatText("**Short text**")
    assert.equal("|cffe3c77eShort text|r", text)
    assert.is_false(pending)

    local body = string.rep("Long text ", 60) .. "end"
    local source = "**" .. body .. "**"
    text, pending = C.FormatText(source)
    assert.equal(source, text)
    assert.is_true(pending)
    local _, unrelatedPending = C.FormatText("Plain text")
    assert.is_false(unrelatedPending)
    for _ = 1, 2000 do
        local _, remaining = C.Markdown.Cache.step()
        if remaining == 0 then
            break
        end
    end
    text, pending = C.FormatText(source)
    assert.equal("|cffe3c77e" .. body .. "|r", text)
    assert.is_false(pending)
    assert.is_nil(C.Markdown.InlineRenderer.pending)
end)
