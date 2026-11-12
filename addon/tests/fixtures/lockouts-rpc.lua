-- Synthetic native-Lua RPC fixture. No player, network or model access.
local helper = require("addon.tests.support")
local env = helper.env()
env.ns = helper.namespace({ session = "fixture-session" })
local now, clock = 1000, 100
env.time = function()
    return now
end
env.GetTime = function()
    return clock
end
env.UnitGUID = function()
    return "Player-fixture"
end
env.CreateFrame = function()
    return {
        RegisterEvent = function() end,
        SetScript = function(_, _, callback)
            env.event = callback
        end,
    }
end
env.GetNumSavedInstances = function()
    return 4
end
env.GetSavedInstanceInfo = function(index)
    if index == 1 then
        return "Later", {}, 7200, 2, true, false, {}, true, 25, "Heroic"
    end
    if index == 2 then
        return "Soon", {}, now == 1000 and 300 or 60, 1, true, false, {}, true, 10, "Normal"
    end
    if index == 3 then
        return "Expired", {}, 0, 1, false, false, {}, true, 10, "Normal"
    end
    return "Unknown"
end
env.RequestRaidInfo = function()
    error("refresh prohibited")
end
helper.addon("Character/Inspect.lua", env)
helper.addon("Character/Lockouts.lua", env)
if arg[1] == "updated" then
    env.event(nil, "UPDATE_INSTANCE_INFO")
    now, clock = 1042, 142
end
if arg[1] == "oversized" then
    env.GetNumSavedInstances = function()
        return 10000
    end
    env.GetSavedInstanceInfo = function()
        return string.rep('"\\\n', 1000),
            {},
            300,
            1,
            true,
            false,
            {},
            true,
            10,
            string.rep("é", 1000)
    end
end

local function encode(value, array)
    if type(value) == "string" then
        return '"'
            .. value:gsub('[%z\1-\31\\"]', function(char)
                return string.format("\\u%04x", char:byte())
            end)
            .. '"'
    end
    if type(value) ~= "table" then
        return tostring(value)
    end
    local parts = {}
    if array or #value > 0 then
        for _, child in ipairs(value) do
            parts[#parts + 1] = encode(child)
        end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, child in pairs(value) do
        parts[#parts + 1] = encode(key) .. ":" .. encode(child, key == "records")
    end
    return "{" .. table.concat(parts, ",") .. "}"
end
print(encode(env.ns.Character.Inspect({ kind = "lockouts", args = { limit = 20 } })))
