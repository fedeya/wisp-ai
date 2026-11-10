local helper = require("addon.tests.support")

it("returns explicit pending status for plain, synchronous, pending and cached text", function()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)
    local ns = env.ns

    local text, pending = ns.UI.FormatText("Plain text")
    assert.equal("Plain text", text)
    assert.is_false(pending)
    text, pending = ns.UI.FormatText("**Short text**")
    assert.equal("|cffe3c77eShort text|r", text)
    assert.is_false(pending)

    local body = string.rep("Long text ", 60) .. "end"
    local source = "**" .. body .. "**"
    text, pending = ns.UI.FormatText(source)
    assert.equal(source, text)
    assert.is_true(pending)
    local _, unrelatedPending = ns.UI.FormatText("Plain text")
    assert.is_false(unrelatedPending)
    for _ = 1, 2000 do
        local _, remaining = ns.Markdown.Cache.Step()
        if remaining == 0 then
            break
        end
    end
    text, pending = ns.UI.FormatText(source)
    assert.equal("|cffe3c77e" .. body .. "|r", text)
    assert.is_false(pending)
    assert.is_nil(ns.Markdown.InlineRenderer.pending)
end)
