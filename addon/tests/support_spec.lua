local helper = require("addon.tests.support")

it("scenario globals and compiled callbacks stay in their own WoW environment", function()
    local first, second = helper.env(), helper.env()
    first.ns = { count = 0 }
    local callback =
        setfenv(assert(loadstring("return function() _G.ns.count = ns.count + 1 end")), first)()
    callback()
    assert.equals(1, first.ns.count)
    assert.is_nil(second.ns)
    assert.is_nil(_G.ns)
end)

it("mocking a standard library does not leak into another scenario or Busted", function()
    local first, second = helper.env(), helper.env()
    local original = table.insert
    first.table.insert = function()
        error("scenario-only mock")
    end
    assert.equals(original, second.table.insert)
    assert.equals(original, table.insert)
end)
