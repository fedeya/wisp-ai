local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    env.ns = helper.namespace({ session = "session" })
    env.now, env.clock, env.guid = 1000, 100, "Player-fixture"
    env.time = function()
        return env.now
    end
    env.GetTime = function()
        return env.clock
    end
    env.UnitGUID = function()
        return env.guid
    end
    env.UnitName = function()
        return "Fixture"
    end
    env.CreateFrame = function()
        return {
            RegisterEvent = function() end,
            SetScript = function(_, _, callback)
                env.event = callback
            end,
        }
    end
    env.RequestRaidInfo = function()
        error("must never refresh")
    end
    env.SetSavedInstanceExtend = function()
        error("must never extend")
    end
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Character/Lockouts.lua", env)
    env.rows = {
        { "Later", {}, 7200, 2, true, false, {}, true, 25, "Heroic" },
        { "Soon", {}, 300, 1, true, false, {}, true, 10, "Normal" },
        { "Expired", {}, 0, 1, false, false, {}, true, 10, "Normal" },
        { "Unknown" },
    }
    env.GetNumSavedInstances = function()
        return #env.rows
    end
    env.GetSavedInstanceInfo = function(i)
        return unpack(env.rows[i])
    end
    return env,
        function(args)
            return env.ns.Character.Inspect({ kind = "lockouts", args = args or {} })
        end
end

describe("cached saved instance lockouts", function()
    it(
        "sorts native durations, preserves expired/unknown fields and never calls refresh",
        function()
            local _, read = setup()
            local result = read()
            assert.equal("partial", result.status)
            assert.equal("Soon", result.data.records[1].name)
            assert.equal(1, result.data.records[1].difficultyId)
            assert.equal("5m 0s", result.data.records[1].resetText)
            assert.equal("Later", result.data.records[2].name)
            assert.equal("inactive", result.data.records[3].lockStatus)
            assert.equal("expired", result.data.records[3].resetStatus)
            assert.is_nil(result.data.records[4].locked)
            assert.equal("unknown", result.data.records[4].resetStatus)
            assert.is_nil(result.data.records[1].instanceId)
            assert.equal("unobserved", result.data.cache.status)
            assert.is_nil(result.data.cache.ageSeconds)
            assert.equal(1000, result.capturedAt)
        end
    )

    it(
        "tracks only actual update events, rereads changed records, and invalidates identity/session",
        function()
            local env, read = setup()
            env.event(nil, "UPDATE_INSTANCE_INFO")
            env.now, env.clock = 1042, 142
            env.rows[2][3] = 60
            local result = read()
            assert.equal(60, result.data.records[1].resetSeconds)
            assert.equal("update_observed", result.data.cache.status)
            assert.equal(1000, result.data.cache.observedAt)
            assert.equal(42, result.data.cache.ageSeconds)
            assert.equal(1042, result.capturedAt)
            env.guid = "Player-other"
            assert.equal("unobserved", read().data.cache.status)
            env.event(nil, "UPDATE_INSTANCE_INFO")
            env.ns.session = "other-session"
            assert.equal("unobserved", read().data.cache.status)
            env.event(nil, "UPDATE_INSTANCE_INFO")
            env.event(nil, "PLAYER_ENTERING_WORLD")
            assert.equal("unobserved", read().data.cache.status)
            env.event(nil, "UPDATE_INSTANCE_INFO")
            local previous = env.guid
            env.guid = nil
            assert.equal("unavailable", read().status)
            env.guid = previous
            assert.equal("unobserved", read().data.cache.status)
        end
    )

    it(
        "keeps public siblings and false flags when fields are restricted or a row throws",
        function()
            local env, read = setup()
            local secret = setmetatable({}, {
                __tostring = function()
                    error("secret coercion")
                end,
            })
            env.issecretvalue = function(value)
                return value == secret
            end
            env.canaccessvalue = function(value)
                return value ~= secret
            end
            env.rows[1][1], env.rows[1][3], env.rows[1][5] = secret, secret, secret
            env.GetSavedInstanceInfo = function(i)
                if i == 2 then
                    error("restricted row")
                end
                return unpack(env.rows[i])
            end
            local result = read()
            assert.equal("partial", result.status)
            assert.equal(4, #result.data.records)
            local row
            for _, record in ipairs(result.data.records) do
                if record.index == 1 then
                    row = record
                end
            end
            assert.is_nil(row.name)
            assert.is_nil(row.resetSeconds)
            assert.is_nil(row.locked)
            assert.is_false(row.extended)
            assert.equal("Heroic", row.difficultyName)
        end
    )

    it("discards all rows on mid-read identity, session or update generation changes", function()
        for _, change in ipairs({ "identity", "session", "event", "transient" }) do
            local env, read = setup()
            env.GetSavedInstanceInfo = function(i)
                if change == "identity" then
                    env.guid = "Player-other"
                elseif change == "session" then
                    env.ns.session = "other"
                elseif change == "transient" then
                    env.event(nil, "PLAYER_ENTERING_WORLD")
                else
                    env.event(nil, "UPDATE_INSTANCE_INFO")
                end
                return unpack(env.rows[i])
            end
            local result = read()
            assert.equal("unavailable", result.status)
            assert.is_nil(result.data)
        end
    end)

    it(
        "distinguishes unknown counts from cached zero, validates inputs and bounds scans/output",
        function()
            local env, read = setup()
            env.GetNumSavedInstances = nil
            assert.equal("unavailable", read().status)
            env.GetNumSavedInstances = function()
                error("not readable")
            end
            assert.equal("unavailable", read().status)
            env.GetNumSavedInstances = function()
                return 0
            end
            assert.equal(0, read().data.cachedCount)
            assert.equal("unobserved", read().data.cache.status)
            assert.equal("unavailable", read({ refresh = true }).status)
            assert.equal("unavailable", read({ limit = 21 }).status)
            local calls = 0
            env.GetNumSavedInstances = function()
                return 10000
            end
            env.GetSavedInstanceInfo = function()
                calls = calls + 1
                return string.rep('"\\\n', 1000),
                    nil,
                    12,
                    1,
                    true,
                    false,
                    nil,
                    true,
                    10,
                    string.rep("é", 1000)
            end
            local result = read({ limit = 20 })
            assert.equal(100, calls)
            assert.is_true(result.data.truncated)
            assert.is_true(result.data.records[1].textTruncated)
            assert.is_true(#result.data.records <= 20)
            assert.is_true(result.data.wireUpperBoundBytes <= 20000)
        end
    )
    it(
        "fails closed for restricted counts/identity and guard exceptions, without coercion",
        function()
            local env, read = setup()
            local secret = setmetatable({}, {
                __tostring = function()
                    error("no coercion")
                end,
            })
            env.issecretvalue = function(value)
                return value == secret
            end
            env.GetNumSavedInstances = function()
                return secret
            end
            assert.equal("unavailable", read().status)
            env.GetNumSavedInstances = function()
                return 1
            end
            env.guid = secret
            assert.equal("unavailable", read().status)
            env.guid = string.rep("x", 201)
            assert.equal("unavailable", read().status)
            env.guid = "Player-fixture"
            env.canaccessvalue = function()
                error("guard failed")
            end
            assert.equal("unavailable", read().status)
        end
    )

    it(
        "never promotes malformed numbers or rewound event clocks to known reset/freshness",
        function()
            local env, read = setup()
            for _, count in ipairs({ -1, 1.5, math.huge, 0 / 0 }) do
                env.GetNumSavedInstances = function()
                    return count
                end
                assert.equal("unavailable", read().status)
            end
            env.GetNumSavedInstances = function()
                return 1
            end
            env.rows[1][3], env.rows[1][4] = math.huge, 1.5
            env.event(nil, "UPDATE_INSTANCE_INFO")
            env.clock = 99
            local result = read()
            assert.equal("partial", result.status)
            assert.is_nil(result.data.records[1].resetSeconds)
            assert.is_nil(result.data.records[1].difficultyId)
            assert.equal("unobserved", result.data.cache.status)
            assert.is_nil(result.data.cache.ageSeconds)
        end
    )
end)
