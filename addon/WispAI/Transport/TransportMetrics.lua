-- Opt-in developer measurement. No collector or OnUpdate runs during normal use.
local _, ns = ...
local active, frame, hooked
local function clock()
    return GetTimePreciseSec and GetTimePreciseSec() or GetTime()
end
local function distribution()
    return { count = 0, sum = 0, max = 0, bins = {} }
end
local function sample(histogram, milliseconds)
    local bucket = math.min(20000, math.max(0, math.floor(milliseconds * 10 + 0.5)))
    histogram.bins[bucket] = (histogram.bins[bucket] or 0) + 1
    histogram.count = histogram.count + 1
    histogram.sum = histogram.sum + milliseconds
    histogram.max = math.max(histogram.max, milliseconds)
end
local function summarize(histogram)
    local ordered = {}
    for bucket in pairs(histogram.bins) do
        ordered[#ordered + 1] = bucket
    end
    table.sort(ordered)
    local result = {
        count = histogram.count,
        mean = histogram.count > 0 and histogram.sum / histogram.count or 0,
        max = histogram.max,
    }
    local cumulative = 0
    for _, bucket in ipairs(ordered) do
        cumulative = cumulative + histogram.bins[bucket]
        for _, percentile in ipairs({ 50, 95, 99 }) do
            local key = "p" .. percentile
            if not result[key] and cumulative >= math.ceil(histogram.count * percentile / 100) then
                result[key] = bucket / 10
            end
        end
    end
    return result
end
function ns.Transport.RecordTransportOperation(kind, milliseconds)
    if active then
        active.work[kind] = active.work[kind] or distribution()
        sample(active.work[kind], milliseconds)
    end
end
function ns.Transport.BeginTransportApply()
    return active and clock() or nil
end
function ns.Transport.RecordTransportSnapshot(data, started)
    if not active then
        return
    end
    local at = clock()
    if started then
        ns.Transport.RecordTransportOperation("apply", (at - started) * 1000)
    end
    local tag = data.benchmark
    if type(tag) ~= "table" or type(tag.id) ~= "string" or #tag.id > 80 then
        return
    end
    local record = active.records[tag.id]
    if not record then
        if active.recordCount >= 32 then
            return
        end
        active.recordCount = active.recordCount + 1
        record = { id = tag.id, count = 0, firstAppliedMs = (at - active.started) * 1000 }
        active.records[tag.id] = record
    end
    record.count = record.count + 1
    record.lastAppliedMs = (at - active.started) * 1000
    if type(tag.textBytes) == "number" and tag.textBytes > 0 and not record.firstTextAppliedMs then
        record.firstTextAppliedMs = record.lastAppliedMs
    end
    if tag.final then
        record.finalAppliedMs = record.lastAppliedMs
    end
    local copies = ns.transportStats and ns.transportStats.downlinkCopy
    if copies then
        record.deepTables = (record.deepTables or 0) + (copies.deepTables or 0)
        record.shallowTables = (record.shallowTables or 0) + (copies.shallowTables or 0)
    end
end
function ns.Transport.StopTransportProfile()
    local profile = active
    if not profile then
        return
    end
    active = nil
    frame:Hide()
    local work, records = {}, {}
    for kind, histogram in pairs(profile.work) do
        work[kind] = summarize(histogram)
    end
    for _, record in pairs(profile.records) do
        records[#records + 1] = record
    end
    table.sort(records, function(a, b)
        return a.id < b.id
    end)
    local report = {
        event = "transport_profile",
        label = profile.label,
        elapsedMs = (clock() - profile.started) * 1000,
        frames = summarize(profile.frames),
        work = work,
        calls = profile.calls,
        records = records,
        compactAck = ns.transportStats and ns.transportStats.compactAck or false,
        startSlot = profile.startSlot,
        endSlot = ns.slot,
        totalBulkLoads = ns.transportStats and ns.transportStats.loads or 0,
        downlinkFrames = ns.transportStats and ns.transportStats.downlinkFrames or 0,
        downlinkMessages = ns.transportStats and ns.transportStats.downlinkMessages or 0,
        downlinkResyncs = ns.transportStats and ns.transportStats.downlinkResyncs or 0,
        downlinkError = ns.transportStats and ns.transportStats.downlinkError or nil,
        bulkAvailable = not ns.bulkUnavailable and (ns.slot or 1) <= (ns.SLOTS or 1024),
    }
    ns.lastTransportProfile = report
    ns.Transport.Send({ type = "inline_status", data = report })
    return report
end
function ns.Transport.StartTransportProfile(label, seconds)
    assert(not active, "A transport profile is already running")
    assert(type(label) == "string" and #label > 0 and #label <= 80, "Invalid profile label")
    assert(
        type(seconds) == "number" and seconds >= 2 and seconds <= 600,
        "Profile duration must be 2 to 600 seconds"
    )
    if not frame then
        frame = CreateFrame("Frame")
        frame:SetScript("OnUpdate", function(_, elapsed)
            if active then
                sample(active.frames, elapsed * 1000)
                if clock() >= active.untilAt then
                    ns.Transport.StopTransportProfile()
                end
            end
        end)
    end
    if not hooked and hooksecurefunc then
        for _, name in ipairs({ "SaveAddOns", "ResetAddOns", "LoadAddOn" }) do
            local key = name
            hooksecurefunc(C_AddOns, key, function()
                if active then
                    active.calls[key] = (active.calls[key] or 0) + 1
                end
            end)
        end
        hooked = true
    end
    local now = clock()
    active = {
        label = label,
        started = now,
        untilAt = now + seconds,
        frames = distribution(),
        work = {},
        calls = {},
        records = {},
        recordCount = 0,
        startSlot = ns.slot,
    }
    frame:Show()
    ns.Transport.Send({
        type = "inline_status",
        data = { event = "transport_profile_start", label = label },
    })
end
