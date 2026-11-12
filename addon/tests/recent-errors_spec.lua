local helper = require("addon.tests.support")

local function setup(env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace({})
    env.now = 0
    env.GetTime = function()
        return env.now
    end
    env.UnitGUID = function()
        return env.guid or "synthetic-character"
    end
    env.issecretvalue = function(value)
        return type(value) == "table" and value.secret
    end
    env.C_Timer.NewTimer = function(_, callback)
        env.expire = callback
        return { Cancel = function() end }
    end
    local create = env.CreateFrame
    env.CreateFrame = function(...)
        local frame = create(...)
        frame.events = {}
        frame.RegisterEvent = function(self, name)
            self.events[name] = true
        end
        frame.UnregisterEvent = function(self, name)
            self.events[name] = nil
        end
        env.capture = frame
        return frame
    end
    helper.addon("Character/RecentErrors.lua", env)
    env.deliver = function(errorType, text)
        if env.capture.events.UI_ERROR_MESSAGE then
            env.capture.scripts.OnEvent(env.capture, "UI_ERROR_MESSAGE", errorType, text)
        end
    end
end

it(
    "retains and orders repeated notices by latest delivery without changing identity or first age",
    function()
        local env = helper.env()
        setup(env)
        local errors = env.ns.RecentErrors
        errors.SetEnabled(true)
        env.deliver(1, "Synthetic A")
        local id = errors.Read().records[1].id
        for i = 2, 30 do
            env.now = i
            env.deliver(i, "Synthetic " .. i)
        end
        env.now = 31
        env.deliver(1, "Synthetic A")
        local repeated = errors.Read().records[30]
        assert(repeated.id == id, "freshest repeated A must move to the newest position")
        assert(repeated.count == 2 and repeated.firstAge == 31 and repeated.latestAge == 0)
        env.now = 32
        env.deliver(31, "Synthetic C")
        local data = errors.Read()
        assert(#data.records == 30 and data.evicted == 1)
        assert(data.records[1].errorType == 3, "evict oldest latest delivery B, not freshest A")
        assert(data.records[29].id == id and data.records[30].text == "Synthetic C")
        -- Force return-budget eviction independently of capture capacity.
        env.C_EncodingUtil = {
            SerializeJSON = function(result)
                return string.rep("x", 1000 + #result.data.records * 1024)
            end,
        }
        local result = errors.BoundResult({ character = "Synthetic", data = data })
        assert(result.data.wireOmitted > 0)
        assert(result.data.records[#result.data.records - 1].id == id)
    end
)

it(
    "captures only after opt-in, omits secret/malformed fields, clips UTF-8 and clears lifecycle state",
    function()
        local env = helper.env()
        setup(env)
        local errors = env.ns.RecentErrors
        env.deliver(1, "disabled")
        assert(not errors.Read().enabled and #errors.Read().records == 0)
        errors.SetEnabled(true)
        local secret = setmetatable({ secret = true }, {
            __tostring = function()
                error("secret coercion")
            end,
            __eq = function()
                error("secret comparison")
            end,
        })
        env.deliver(secret, "omit")
        env.deliver(1, secret)
        env.deliver(0, "malformed")
        env.deliver(1, string.rep("é", 257))
        local data = errors.Read()
        assert(data.omitted == 3 and data.clipped == 1)
        assert(#data.records == 1 and #data.records[1].text == 512 and data.records[1].truncated)
        env.now = 120
        env.expire()
        assert(#errors.Read().records == 0 and errors.Read().expired == 1)
        env.deliver(1, "clear")
        errors.SetEnabled(false)
        assert(not env.capture.events.UI_ERROR_MESSAGE and #errors.Read().records == 0)
        errors.SetEnabled(true)
        env.deliver(1, "character change")
        env.guid = "another-synthetic-character"
        env.capture.scripts.OnEvent(env.capture, "PLAYER_ENTERING_WORLD")
        assert(not errors.Read().enabled and #errors.Read().records == 0)
        errors.SetEnabled(true)
        env.deliver(1, "logout")
        env.capture.scripts.OnEvent(env.capture, "PLAYER_LOGOUT")
        assert(not errors.Read().enabled and #errors.Read().records == 0)
    end
)
