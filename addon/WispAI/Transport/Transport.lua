-- Wisp's checked, reusable transport. Only the W2 wire format is supported.
local _, ns = ...
local integer = ns.Shared.Numbers.IsNonNegativeInteger
local character
local function missingAPI()
    if
        type(bit) ~= "table"
        or type(bit.bxor) ~= "function"
        or type(bit.band) ~= "function"
        or type(bit.rshift) ~= "function"
    then
        return "bit.bxor, bit.band and bit.rshift"
    end
    for _, name in ipairs({
        "DoesAddOnExist",
        "ResetAddOns",
        "GetAddOnEnableState",
        "EnableAddOn",
        "DisableAddOn",
        "SaveAddOns",
        "LoadAddOn",
    }) do
        if type(C_AddOns) ~= "table" or type(C_AddOns[name]) ~= "function" then
            return "C_AddOns." .. name
        end
    end
    for _, name in ipairs({ "SerializeJSON", "DeserializeJSON", "CompressString" }) do
        if type(C_EncodingUtil) ~= "table" or type(C_EncodingUtil[name]) ~= "function" then
            return "C_EncodingUtil." .. name
        end
    end
    if not (Enum and Enum.CompressionMethod and Enum.CompressionMethod.Zlib) then
        return "Enum.CompressionMethod.Zlib"
    end
    if type(UnitGUID) ~= "function" then
        return "UnitGUID"
    end
end
local unsupported = missingAPI()
local supportsMailbox = ns.Transport.ApplyDownlink
    and type(C_EncodingUtil) == "table"
    and C_EncodingUtil.DecompressString
local reusable = not unsupported and supportsMailbox ~= nil and supportsMailbox ~= false
local compactAck = false
-- The 50 ms ticker bounds compact reads; allow 10 ms of scheduler jitter so
-- a slightly early callback does not defer useful data for another full tick.
local COMPACT_RECEIVE_DELAY = 0.04
local cachedControl
local baselinePending, persistedControl = true, nil
local pendingWireAck, lastDataFrame, lastDataAck, partialDownlink
local lastAcknowledgedFrame
local downlinkUntil = 0
local nextAckRetry, ackRetryDelay = 0, 0.25
local wireSequence = 0
local publishedState = {}
local generation = (time() * 1000.0 + math.random(1, 999999)) % 4294967295 + 1
local upBits, downNames, crcTable = {}, {}, {}
local function pack16(value)
    return string.char(math.floor(value / 256) % 256, value % 256)
end
local function pack32(value)
    return pack16(math.floor(value / 65536)) .. pack16(value % 65536)
end
local function unpack32(text, offset)
    local a, b, c, d = text:byte(offset, offset + 3)
    return ((a * 256.0 + b) * 256 + c) * 256 + d
end
for index = 0, 767 do
    upBits[index + 1] = {
        name = string.format("WispAI_S%04d", index + 257),
        byte = math.floor(index / 8) + 1,
        mask = 2 ^ (index % 8),
    }
end
for index = 1, 384 do
    downNames[index] = index <= 128 and string.format("WispAI_B%03d", index)
        or string.format("WispAI_S%04d", index - 128)
end
local function initializeCRC()
    if crcTable[0] then
        return
    end
    for index = 0, 255 do
        local value = index
        for _ = 1, 8 do
            value = bit.bxor(bit.rshift(value, 1), bit.band(value, 1) == 1 and 0xEDB88320 or 0)
        end
        crcTable[index] = value
    end
end
if not unsupported then
    initializeCRC()
end
local function crc(text)
    local value = -1
    for index = 1, #text do
        value = bit.bxor(
            bit.rshift(value, 8),
            crcTable[bit.band(bit.bxor(value, text:byte(index)), 255)]
        )
    end
    return bit.bxor(value, -1) % 4294967296
end
local function checkedFrame(payload, flags)
    local frame = "W2"
        .. string.char(1, flags)
        .. pack32(generation)
        .. pack16(wireSequence)
        .. pack16(#payload)
        .. payload
        .. string.rep("\0", 80 - #payload)
    wireSequence = (wireSequence + 1) % 65536
    return frame .. pack32(crc(frame))
end
local function readControl()
    local started = GetTimePreciseSec and GetTimePreciseSec() or GetTime()
    C_AddOns.ResetAddOns()
    -- Reset rereads the physical file and can roll back a recently written
    -- uplink bit. Invalidate the cache before the next transmission.
    publishedState = {}
    local function readByte(byte)
        local value = 0
        for position = 0, 7 do
            if C_AddOns.GetAddOnEnableState(downNames[byte * 8 + position + 1], character) == 2 then
                value = value + 2 ^ position
            end
        end
        return string.char(value)
    end
    -- Reuse only an already CRC-validated frame. Generation, sequence, flags,
    -- length and checksum identify it; a new identity always reads the body.
    local header, checksum = {}, {}
    for byte = 0, 11 do
        header[#header + 1] = readByte(byte)
    end
    for byte = 44, 47 do
        checksum[#checksum + 1] = readByte(byte)
    end
    header, checksum = table.concat(header), table.concat(checksum)
    local identity = header .. checksum
    local frame
    if cachedControl and cachedControl.identity == identity then
        frame = cachedControl.raw
        ns.transportStats.cachedReads = (ns.transportStats.cachedReads or 0) + 1
    else
        local body = {}
        for byte = 12, 43 do
            body[#body + 1] = readByte(byte)
        end
        frame = header .. table.concat(body) .. checksum
    end
    local elapsed = ((GetTimePreciseSec and GetTimePreciseSec() or GetTime()) - started) * 1000
    ns.transportStats.resetMs = elapsed
    ns.transportStats.maxResetMs = math.max(ns.transportStats.maxResetMs or 0, elapsed)
    if ns.Transport.RecordTransportOperation then
        ns.Transport.RecordTransportOperation("reset", elapsed)
    end
    local flags = frame:byte(4)
    local kind = frame:byte(3)
    if
        frame:sub(1, 2) ~= "W2"
        or (kind ~= 2 and kind ~= 4)
        or (kind == 4 and not reusable)
        or flags > 7
        or unpack32(frame, 45) ~= crc(frame:sub(1, 44))
    then
        return
    end
    local length = frame:byte(11) * 256 + frame:byte(12)
    if
        length > 32
        or unpack32(frame, 5) == 0
        or frame:sub(13 + length, 44) ~= string.rep("\0", 32 - length)
    then
        return
    end
    cachedControl = { identity = identity, raw = frame }
    local incoming = {
        generation = unpack32(frame, 5),
        sequence = frame:byte(9) * 256 + frame:byte(10),
        flags = flags,
        payload = frame:sub(13, 12 + length),
        raw = frame,
        compact = kind == 4,
    }
    if reusable and bit.band(flags, 4) ~= 0 then
        return incoming
    end
    if flags ~= 3 then
        return
    end
    local ok, control = pcall(C_EncodingUtil.DeserializeJSON, incoming.payload)
    if
        ok
        and type(control) == "table"
        and integer(control.r)
        and control.r > 0
        and control.r <= 9007199254740991
    then
        incoming.revision = control.r
        return incoming
    end
end
local seq, queue, awaiting = 0, {}, {}
local transmitting
local transportStarted, unavailableLogged = false, false
local deliveries, reports = {}, {}
local acknowledgedReport
local acknowledgmentUntil = 0
local nextReceive, emptyDelay, activeUntil = 0, 0.5, 0
ns.transportStats = { loads = 0, unchanged = 0, version = 2 }
ns.slot = 1
local function unavailable(reason)
    local message = "Wisp bridge v2 is unavailable: "
        .. reason
        .. ". Update WoW and restart after installing Wisp."
    ns.transportStats.error = message
    if not unavailableLogged then
        ns.Core.Log(message)
        unavailableLogged = true
    end
    return false
end
local function acknowledgeDownlink(frame, resync)
    if not reusable then
        return
    end
    if lastAcknowledgedFrame == frame.raw and GetTime() < nextAckRetry then
        return
    end
    pendingWireAck = {
        a = { frame.generation, frame.sequence, ns.rev },
        b = not ns.bulkUnavailable and ns.slot <= ns.SLOTS,
        n = resync or nil,
        compact = frame.compact or nil,
    }
    if lastAcknowledgedFrame ~= frame.raw then
        -- Outlast the host's five-second restart watchdog, then return to idle.
        downlinkUntil = GetTime() + 8
        ackRetryDelay = 0.25
        lastAcknowledgedFrame = frame.raw
    end
end
local function receiveData(frame)
    if frame.raw == lastDataFrame then
        if GetTime() >= nextAckRetry then
            pendingWireAck = lastDataAck
        end
        return
    end
    ns.transportStats.downlinkFrames = (ns.transportStats.downlinkFrames or 0) + 1
    if bit.band(frame.flags, 1) ~= 0 then
        partialDownlink = { parts = {}, size = 0, sequence = (frame.sequence - 1) % 65536 }
    end
    local valid = partialDownlink and frame.sequence == (partialDownlink.sequence + 1) % 65536
    if valid then
        partialDownlink.size = partialDownlink.size + #frame.payload
        valid = partialDownlink.size <= 65536
    end
    local resync = not valid
    if valid then
        partialDownlink.sequence = frame.sequence
        partialDownlink.parts[#partialDownlink.parts + 1] = frame.payload
        if bit.band(frame.flags, 2) ~= 0 then
            local body = table.concat(partialDownlink.parts)
            partialDownlink = nil
            local applyStarted = GetTimePreciseSec and GetTimePreciseSec() or GetTime()
            local ok, reason = pcall(function()
                local json = C_EncodingUtil.DecompressString(body, Enum.CompressionMethod.Zlib)
                assert(type(json) == "string" and #json <= 1048576, "Decoded snapshot too large")
                ns.Transport.ApplyDownlink(C_EncodingUtil.DeserializeJSON(json))
            end)
            if ns.Transport.RecordTransportOperation then
                ns.Transport.RecordTransportOperation(
                    "decode_apply",
                    ((GetTimePreciseSec and GetTimePreciseSec() or GetTime()) - applyStarted) * 1000
                )
            end
            resync = not ok
            ns.transportStats.downlinkError = not ok and tostring(reason) or nil
            if ok then
                ns.transportStats.downlinkMessages = (ns.transportStats.downlinkMessages or 0) + 1
            end
        end
    else
        partialDownlink = nil
    end
    if resync then
        ns.transportStats.downlinkResyncs = (ns.transportStats.downlinkResyncs or 0) + 1
    end
    acknowledgeDownlink(frame, resync)
    lastDataFrame, lastDataAck = frame.raw, pendingWireAck
end
function ns.Transport.WakeTransport()
    nextReceive = 0
    emptyDelay = 0.5
    activeUntil = GetTime() + 12
end
local function frames(packet)
    packet.nextSlot = math.min(ns.slot, ns.SLOTS)
    packet.receivedRev = ns.rev
    packet.transportVersion = 2
    packet.mailboxVersion = reusable and 1 or nil
    packet.compactAck = reusable and true or nil
    packet.bulkAvailable = reusable and not ns.bulkUnavailable and ns.slot <= ns.SLOTS or nil
    if reusable and (ns.bulkUnavailable or ns.slot > ns.SLOTS) then
        packet.bulkAvailable = false
    end
    packet.transport = nil
    if packet.type == "poll" or packet.type == "hello" then
        if ns.transportStats.delivery or ns.transportStats.loadError or ns.transportStats.error then
            packet.transport = {
                loadError = ns.transportStats.loadError,
                error = ns.transportStats.error,
                delivery = ns.transportStats.delivery,
            }
        end
    end
    local envelope = {}
    for key, value in pairs(packet) do
        if key ~= "queued" and key ~= "lastSent" and key ~= "enqueuedAt" then
            envelope[key] = value
        end
    end
    local body = C_EncodingUtil.CompressString(
        C_EncodingUtil.SerializeJSON(envelope),
        Enum.CompressionMethod.Zlib
    )
    if #body > 65535 then
        error("Message is too large")
    end
    local out = {}
    for i = 1, #body, 80 do
        out[#out + 1] =
            checkedFrame(body:sub(i, i + 79), 4 + (i == 1 and 1 or 0) + (i + 80 > #body and 2 or 0))
    end
    return out, #body
end
local function priority(packet)
    if packet.type == "hello" then
        return 0
    end
    if packet.type == "poll" or packet.heartbeat then
        return 4
    elseif packet.type == "quest_sync" then
        return 3
    end
    return 1
end
local function enqueue(packet)
    local started = GetTimePreciseSec and GetTimePreciseSec() or GetTime()
    local encoded, bytes = frames(packet)
    local elapsed = ((GetTimePreciseSec and GetTimePreciseSec() or GetTime()) - started) * 1000
    ns.transportStats.encodeMs = elapsed
    ns.transportStats.maxEncodeMs = math.max(ns.transportStats.maxEncodeMs or 0, elapsed)
    local item = { packet = packet, frames = encoded, index = 1 }
    if packet.messageId then
        if not deliveries[packet.seq] then
            deliveries[packet.seq] =
                { enqueuedAt = packet.enqueuedAt, bytes = bytes, frames = #encoded, retries = 0 }
        else
            deliveries[packet.seq].retries = deliveries[packet.seq].retries + 1
        end
    end
    -- Replace unsent polls instead of building a backlog of obsolete cursors.
    for index = #queue, 1, -1 do
        if queue[index].packet.type == "poll" and queue[index].index == 1 then
            queue[index].packet.queued = nil
            table.remove(queue, index)
        end
    end
    local position = #queue + 1
    for index, other in ipairs(queue) do
        -- Never interrupt a framed packet: the decoder needs its remaining bytes.
        if other.index == 1 and priority(packet) < priority(other.packet) then
            position = index
            break
        end
    end
    table.insert(queue, position, item)
    packet.queued = true
end
function ns.Transport.Send(packet)
    if unsupported then
        return unavailable("missing " .. unsupported)
    end
    seq = seq + 1
    if
        (packet.type == "hello" or packet.type == "say" or packet.type == "capabilities_list")
        and ns.Integrations.IntegrationReport
    then
        local report = ns.Integrations.IntegrationReport()
        local signature = C_EncodingUtil.SerializeJSON(report)
        if packet.type ~= "say" or signature ~= acknowledgedReport then
            packet.integrations = report
            if not packet.heartbeat then
                reports[seq] = signature
            end
        end
    end
    packet.session = ns.session
    packet.seq = seq
    packet.at = time()
    packet.enqueuedAt = GetTime()
    if packet.messageId and packet.chat and ns.Transport.BeginResponseTiming then
        ns.Transport.BeginResponseTiming(packet.chat, packet.messageId, packet.enqueuedAt)
    end
    local ok, err = pcall(enqueue, packet)
    if not ok then
        if packet.type ~= "state_result" then
            reports[seq] = nil
            error(err)
        end
        -- A malformed provider result must reach the bridge as an error,
        -- rather than leaving a request waiting for its full timeout. Never
        -- repeat the underlying inspection/action to recover serialization.
        packet.data = {
            status = "unavailable",
            error = "Could not encode game result: " .. tostring(err),
        }
        enqueue(packet)
    end
    if packet.type ~= "poll" and not packet.heartbeat then
        awaiting[seq] = packet
        ns.Transport.WakeTransport()
    end
end
function ns.Transport.Acknowledge(ids)
    local refreshed = false
    for _, id in ipairs(ids) do
        local packet = awaiting[id]
        if packet then
            local timing = packet.chat and ns.responseTiming and ns.responseTiming[packet.chat]
            if timing and timing.messageId == packet.messageId then
                timing.acknowledgedAt = GetTime()
            end
            if reports[id] then
                acknowledgedReport = reports[id]
            end
            if packet.context and packet.context.characterRevision then
                ns.characterAcknowledged =
                    math.max(ns.characterAcknowledged or 0, packet.context.characterRevision)
            end
            if packet.context and packet.context.questRevision then
                ns.questAcknowledged =
                    math.max(ns.questAcknowledged or 0, packet.context.questRevision)
            end
            local pending = packet.messageId and (ns.pendingMessages or {})[packet.messageId]
            if pending then
                pending.acknowledged = true
                refreshed = true
                ns.transportStats.deliveryMs = math.floor((GetTime() - packet.enqueuedAt) * 1000)
                local stats = deliveries[id]
                ns.transportStats.delivery =
                    { messageId = packet.messageId, ms = ns.transportStats.deliveryMs }
                if stats then
                    local result = ns.transportStats.delivery
                    result.queueMs = stats.startedAt
                        and math.floor((stats.startedAt - stats.enqueuedAt) * 1000)
                    result.transmitMs = stats.finishedAt
                        and math.floor((stats.finishedAt - stats.startedAt) * 1000)
                    result.ackMs = stats.finishedAt
                        and math.floor((GetTime() - stats.finishedAt) * 1000)
                    result.bytes, result.frames, result.retries =
                        stats.bytes, stats.frames, stats.retries
                end
            end
            for index = #queue, 1, -1 do
                if queue[index].packet == packet and queue[index].index == 1 then
                    table.remove(queue, index)
                    packet.queued = nil
                end
            end
        end
        awaiting[id] = nil
        deliveries[id], reports[id] = nil, nil
    end
    if refreshed then
        acknowledgmentUntil = 0
        if ns.UI.Refresh then
            ns.UI.Refresh()
        end
        if ns.Inline.RefreshInline then
            ns.Inline.RefreshInline()
        end
    end
end
function ns.Transport.CancelPendingChat(id)
    for key, packet in pairs(awaiting) do
        if packet.chat == id then
            awaiting[key] = nil
            deliveries[key], reports[key] = nil, nil
        end
    end
    for index = #queue, 1, -1 do
        if queue[index].packet.chat == id then
            table.remove(queue, index)
        end
    end
end
local function transmit()
    if AddonList and AddonList:IsShown() then
        return
    end
    local item = queue[1]
    local wireAck = reusable and pendingWireAck and (not item or item.index == 1) and pendingWireAck
    if not item and not wireAck then
        return
    end
    if baselinePending then
        -- Downlink settings survive /reload. Capture the old physical identity
        -- before our first publication lets the host answer this addon session.
        local previous = readControl()
        persistedControl = previous and previous.raw or nil
        baselinePending = false
    end
    local stats = not wireAck and deliveries[item.packet.seq]
    if stats and not stats.startedAt then
        stats.startedAt = GetTime()
    end
    local started = GetTimePreciseSec and GetTimePreciseSec() or GetTime()
    local frame
    if wireAck and wireAck.compact then
        local flags = (wireAck.n and 1 or 0) + (wireAck.b and 2 or 0)
        local header = "W2"
            .. string.char(3, flags)
            .. pack32(wireAck.a[1])
            .. pack16(wireAck.a[2])
            .. pack16(0)
        frame = header .. pack32(crc(header))
    else
        frame = wireAck and checkedFrame(C_EncodingUtil.SerializeJSON(wireAck), 3)
            or item.frames[item.index]
    end
    -- W2 carriers are LSB-first. Compact acknowledgements cover only the first
    -- 128 carriers; the remainder retains its physical and cached state.
    for index = 1, #frame * 8 do
        local carrier = upBits[index]
        local desired = bit.band(frame:byte(carrier.byte), carrier.mask) ~= 0 and 2 or 0
        local observed = publishedState[carrier.name]
        if observed == nil then
            observed = C_AddOns.GetAddOnEnableState(carrier.name, character)
        end
        if observed ~= desired then
            local apply = desired == 2 and C_AddOns.EnableAddOn or C_AddOns.DisableAddOn
            apply(carrier.name, character)
        end
        publishedState[carrier.name] = desired
    end
    C_AddOns.SaveAddOns()
    local elapsed = ((GetTimePreciseSec and GetTimePreciseSec() or GetTime()) - started) * 1000
    ns.transportStats.sendMs = elapsed
    ns.transportStats.maxSendMs = math.max(ns.transportStats.maxSendMs or 0, elapsed)
    if ns.Transport.RecordTransportOperation then
        ns.Transport.RecordTransportOperation(wireAck and "ack" or "send", elapsed)
    end
    if wireAck then
        pendingWireAck = nil
        nextAckRetry = GetTime() + ackRetryDelay
        ackRetryDelay = math.min(2, ackRetryDelay * 2)
        return
    end
    item.index = item.index + 1
    if item.index > #item.frames then
        item.packet.queued = nil
        item.packet.lastSent = GetTime()
        if stats then
            stats.finishedAt = stats.finishedAt or GetTime()
            acknowledgmentUntil = GetTime() + 2
            -- The ack cannot exist before the final frame. Start its short
            -- polling window now, without inherited pre-transmission backoff.
            nextReceive = GetTime() + 0.04
            emptyDelay = 0.5
        end
        table.remove(queue, 1)
    end
end
local controlGeneration
local retiredGenerations = {}
local retiredOrder = {}
local function receive()
    if baselinePending then
        return
    end
    local unsent, sent = false, false
    for _, packet in pairs(awaiting) do
        if packet.messageId then
            if packet.lastSent then
                sent = true
            else
                unsent = true
            end
        end
    end
    if unsent and not sent then
        return
    end
    if queue[1] then
        return
    end
    -- The hello can be acknowledged before Eve is ready. Keep reading until
    -- startup completes, even after that acknowledgement clears the outbox.
    local waiting = not ns.connected or next(awaiting) ~= nil or partialDownlink ~= nil
    local firstTextWaiting = false
    for _, chat in ipairs(ns.chats or {}) do
        if chat.status == "working" then
            waiting = true
            local timing = ns.responseTiming and ns.responseTiming[chat.id]
            if timing and not timing.hasText and GetTime() - timing.startedAt < 15 then
                firstTextWaiting = true
            end
        end
    end
    -- Read only while waiting for startup or a user turn. Idle clients do not
    -- consume one-use channels; unchanged replies back off below.
    if (not waiting and GetTime() >= downlinkUntil) or GetTime() < nextReceive then
        return
    end
    if AddonList and AddonList:IsShown() then
        return
    end
    nextReceive = GetTime() + (waiting and (compactAck and COMPACT_RECEIVE_DELAY or 0.1) or 0.5)
    local incoming = readControl()
    if not incoming then
        return
    end
    if persistedControl then
        if incoming.raw == persistedControl then
            return
        end
        persistedControl = nil
    end
    local incomingGeneration = incoming.generation
    if incomingGeneration ~= controlGeneration then
        if retiredGenerations[incomingGeneration] then
            return
        end
        if controlGeneration then
            retiredGenerations[controlGeneration] = true
            retiredOrder[#retiredOrder + 1] = controlGeneration
            if #retiredOrder > 16 then
                retiredGenerations[table.remove(retiredOrder, 1)] = nil
            end
        end
        controlGeneration = incomingGeneration
        partialDownlink, lastDataFrame, lastDataAck = nil, nil, nil
        if reusable then
            -- Revision counters belong to a host generation. Keep rendered
            -- UI state until its replacement arrives, but accept a restarted
            -- host even when its counter or wall clock moved backwards.
            ns.rev = 0
        end
        if ns.Transport.ClearDownlink then
            ns.Transport.ClearDownlink()
        end
    end
    compactAck = incoming.compact
    ns.transportStats.compactAck = compactAck or nil
    nextReceive = GetTime() + (waiting and (compactAck and COMPACT_RECEIVE_DELAY or 0.1) or 0.5)
    if not incoming.revision then
        receiveData(incoming)
        return
    end
    if incoming.revision <= ns.rev then
        acknowledgeDownlink(incoming)
        return
    end
    if reusable and (ns.bulkUnavailable or ns.slot > ns.SLOTS) then
        ns.exhausted = false
        acknowledgeDownlink(incoming, true)
        return
    end
    -- Keep the notification identity until the bulk read below can confirm
    -- the revision (or request a reusable fallback if loading fails).
    lastDataFrame, lastDataAck = nil, nil
    partialDownlink = nil
    ns.pendingBulkNotification = incoming
    if ns.slot > ns.SLOTS then
        ns.exhausted = true
        if ns.UI.Refresh then
            ns.UI.Refresh()
        end
        return
    end
    local name = string.format("WispAI_S%04d", ns.slot)
    local enabledBefore = C_AddOns.GetAddOnEnableState(name, character)
    C_AddOns.EnableAddOn(name, character)
    ns.slot = ns.slot + 1
    local before = ns.rev
    local outcome = {}
    ns.bulkRead = outcome
    local ok, loaded, reason = pcall(C_AddOns.LoadAddOn, name)
    ns.bulkRead = nil
    if not ok then
        loaded, reason = nil, loaded
    end
    if enabledBefore == 0 then
        C_AddOns.DisableAddOn(name, character)
    end
    ns.transportStats.loadError = not loaded and tostring(reason) or nil
    if loaded then
        ns.transportStats.loads = ns.transportStats.loads + 1
        if ns.slot > ns.SLOTS then
            ns.exhausted = not reusable
            if ns.UI.Refresh then
                ns.UI.Refresh()
            end
        end
        if ns.rev > before then
            emptyDelay = 0.5
            nextReceive = GetTime() + (compactAck and COMPACT_RECEIVE_DELAY or 0.1)
        else
            ns.transportStats.unchanged = ns.transportStats.unchanged + 1
            nextReceive = GetTime()
                + (
                    GetTime() < acknowledgmentUntil and 0.25
                    or (firstTextWaiting and 0.5 or emptyDelay)
                )
            emptyDelay = math.min(GetTime() < activeUntil and 2 or 8, emptyDelay * 2)
        end
    else
        ns.slot = ns.slot - 1
        nextReceive = GetTime() + 2
    end
    if reusable and ns.pendingBulkNotification then
        local previousSession = loaded
            and ns.rev == before
            and outcome.session ~= nil
            and outcome.session ~= ns.session
        if previousSession then
            -- An old turn may publish after the startup baseline while hello
            -- is still in flight. Its rejected payload does not break the bank.
            ns.transportStats.staleBulkReads = (ns.transportStats.staleBulkReads or 0) + 1
        elseif not loaded or ns.rev == before then
            ns.bulkUnavailable = true
        end
        acknowledgeDownlink(ns.pendingBulkNotification, not loaded or ns.rev == before)
        ns.pendingBulkNotification = nil
        ns.exhausted = false
        nextReceive = GetTime() + (compactAck and COMPACT_RECEIVE_DELAY or 0.1)
    end
end
function ns.Transport.StartTransport()
    if transportStarted then
        return true
    end
    unsupported = missingAPI()
    if unsupported then
        return unavailable("missing " .. unsupported)
    end
    -- Cold login can expose the Lua files before UnitGUID is ready.
    character = UnitGUID("player")
    if not character then
        return unavailable("the active character GUID is not ready")
    end
    initializeCRC()
    reusable = supportsMailbox ~= nil and supportsMailbox ~= false
    ns.reusableDownlink = reusable
    ns.transportStats.mailboxVersion = reusable and 1 or nil
    for _, helper in ipairs({
        "WispAI_B128",
        "WispAI_S0001",
        "WispAI_S0256",
        "WispAI_S0257",
        "WispAI_S1024",
    }) do
        if not C_AddOns.DoesAddOnExist(helper) then
            return unavailable("helper channels are missing (" .. helper .. ")")
        end
    end
    transportStarted = true
    ns.transportStats.error = nil
    transmitting = C_Timer.NewTicker(0.04, function()
        local ok, err = pcall(transmit)
        if not ok then
            ns.Core.Log(tostring(err))
            transmitting:Cancel()
        end
    end)
    C_Timer.NewTicker(0.5, function()
        if not compactAck then
            local ok, reason = pcall(receive)
            ns.transportStats.error = not ok and tostring(reason) or nil
        end
    end)
    C_Timer.NewTicker(0.1, function()
        if not compactAck then
            local ok, reason = pcall(receive)
            ns.transportStats.error = not ok and tostring(reason) or nil
        end
    end)
    C_Timer.NewTicker(0.05, function()
        if compactAck then
            local ok, reason = pcall(receive)
            ns.transportStats.error = not ok and tostring(reason) or nil
        end
    end)
    C_Timer.NewTicker(2, function()
        local renewed
        for _, packet in pairs(awaiting) do
            if not packet.queued and packet.lastSent and GetTime() - packet.lastSent > 5 then
                if not renewed then
                    -- A fresh bridge must negotiate a hello, never replay a
                    -- cached action from the previous process. Renew the
                    -- handshake before retrying an unacknowledged request.
                    local context
                    if ns.Character.CaptureTurn then
                        ns.characterAcknowledged, ns.questAcknowledged = 0, 0
                        local ok, captured = pcall(ns.Character.CaptureTurn)
                        if ok then
                            context = captured
                        end
                    end
                    ns.Transport.Send({
                        type = "hello",
                        chat = ns.active,
                        context = context,
                        heartbeat = true,
                    })
                    renewed = true
                end
                enqueue(packet)
            end
        end
    end)
    C_Timer.NewTicker(60, function()
        ns.Transport.Send({ type = "hello", chat = ns.active, heartbeat = true })
    end)
    return true
end
