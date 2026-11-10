local helper = require("addon.tests.support")

it("scenario globals and compiled callbacks stay in their own WoW environment", function()
    local first, second = helper.env(), helper.env()
    first.C = { count = 0 }
    local callback = assert(first.load("return function() _G.C.count = C.count + 1 end"))()
    callback()
    assert.equals(1, first.C.count)
    assert.is_nil(second.C)
    assert.is_nil(_G.C)
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
