local helper = require("addon.tests.support")

local function setup(_ENV)
    do
        now = 0
        hooks = {}
        sent = {}
        created = 0
        function GetTimePreciseSec()
            return now
        end
        function CreateFrame()
            created = created + 1
            widget = {
                SetScript = function(self, _, fn)
                    self.update = fn
                end,
                Hide = function(self)
                    self.hidden = true
                end,
                Show = function(self)
                    self.hidden = false
                end,
            }
            return widget
        end
        C_AddOns = {
            SaveAddOns = function() end,
            ResetAddOns = function() end,
            LoadAddOn = function() end,
        }
        function hooksecurefunc(_, key, fn)
            hooks[key] = fn
        end
        C = {
            transportStats = { compactAck = true },
            Send = function(packet)
                sent[#sent + 1] = packet
            end,
        }
    end
    helper.addon("TransportMetrics.lua", _ENV)
end

it(
    "profiling stays opt-in, captures frame percentiles and stops without an idle OnUpdate",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        assert(created == 0 and next(hooks) == nil)
        C.RecordTransportOperation("ack", 900)
        assert(not pcall(C.StartTransportProfile, "", 2))
        C.StartTransportProfile("fixture", 2)
        assert(created == 1 and sent[1].data.event == "transport_profile_start")
        assert(not pcall(C.StartTransportProfile, "overlap", 2))
        hooks.SaveAddOns()
        hooks.SaveAddOns()
        hooks.ResetAddOns()
        for i = 1, 100 do
            now = now + 0.01
            widget.update(widget, 0.01)
        end
        C.RecordTransportOperation("ack", 3)
        C.RecordTransportOperation("ack", 5)
        now = 2.01
        widget.update(widget, 0.02)
        local result = C.lastTransportProfile
        assert(widget.hidden and result.frames.count == 101)
        assert(result.frames.p50 == 10 and result.frames.p95 == 10 and result.frames.max == 20)
        assert(result.calls.SaveAddOns == 2 and result.calls.ResetAddOns == 1)
        assert(
            result.work.ack.count == 2 and result.work.ack.mean == 4 and result.work.ack.max == 5
        )
        assert(sent[2].data.event == "transport_profile")
        hooks.SaveAddOns()
        C.RecordTransportOperation("ack", 99)
        assert(result.calls.SaveAddOns == 2 and result.work.ack.count == 2)
        assert(C.StopTransportProfile() == nil)
    end
)

it(
    "benchmark state timing aggregates bounded fixture data without calling it visible text",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        C.StartTransportProfile("timing", 10)
        now = 0.1
        local started = C.BeginTransportApply()
        now = 0.104
        C.RecordTransportSnapshot(
            { benchmark = { id = "stream", step = 1, textBytes = 3 } },
            started
        )
        now = 0.2
        C.RecordTransportSnapshot(
            { benchmark = { id = "stream", step = 2, textBytes = 12, final = true } },
            nil
        )
        local result = C.StopTransportProfile()
        assert(#result.records == 1 and result.records[1].count == 2)
        assert(math.abs(result.records[1].firstTextAppliedMs - 104) < 0.001)
        assert(result.records[1].finalAppliedMs == 200)
        assert(result.work.apply.count == 1 and math.abs(result.work.apply.mean - 4) < 0.001)
        assert(result.records[1].visibleMs == nil)
    end
)
