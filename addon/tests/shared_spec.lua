local helper = require("addon.tests.support")

local function shared()
    local env = helper.env()
    env.ns = helper.namespace()
    helper.addon("Shared/Numbers.lua", env)
    helper.addon("Shared/Text.lua", env)
    return env.ns.Shared
end

it("distinguishes finite numbers and non-negative integers without coercing values", function()
    local numbers = shared().Numbers
    for _, value in ipairs({ 0, 1, 9007199254740991, 9007199254740992 }) do
        assert.is_true(numbers.IsFinite(value))
        assert.is_true(numbers.IsNonNegativeInteger(value))
    end
    for _, value in ipairs({ -1, -0.5, 0.5 }) do
        assert.is_true(numbers.IsFinite(value))
        assert.is_false(numbers.IsNonNegativeInteger(value))
    end
    for _, value in ipairs({ 0 / 0, math.huge, -math.huge, "1", false, {} }) do
        assert.is_false(numbers.IsFinite(value))
        assert.is_false(numbers.IsNonNegativeInteger(value))
    end
    assert.is_false(numbers.IsFinite(nil))
    assert.is_false(numbers.IsNonNegativeInteger(nil))
end)

it("truncates at UTF-8 byte boundaries and reports whether the input was clipped", function()
    local truncate = shared().Text.TruncateUtf8Bytes
    for _, case in ipairs({
        { "", { "" } },
        { "abc", { "", "a", "ab", "abc" } },
        { "é", { "", "é" } },
        { "世", { "", "世" } },
        { "😀", { "", "😀" } },
        { "aé世😀z", { "", "a", "aé", "aé世", "aé世😀", "aé世😀z" } },
    }) do
        local text, prefixes = case[1], case[2]
        for bytes = 0, #text + 1 do
            local expected = ""
            for _, prefix in ipairs(prefixes) do
                if #prefix <= bytes then
                    expected = prefix
                end
            end
            local result, truncated = truncate(text, bytes)
            assert.equals(expected, result)
            assert.equals(#text > bytes, truncated)
        end
    end
end)
