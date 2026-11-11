-- Reconstruct immutable transport snapshots before the UI merges optimistic state.
local _, ns = ...
local numbers = ns.Shared.Numbers
local baseline
local baselineEpoch = 0
local preparedProjection
local forbidden = { __proto__ = true, constructor = true, prototype = true }
local function integer(value, minimum)
    return numbers.IsNonNegativeInteger(value) and value >= minimum and value <= 9007199254740991
end
local function copyStats(phase)
    local stats = {
        phase = phase,
        deepTables = 0,
        deepNodes = 0,
        shallowTables = 0,
        shallowEntries = 0,
        committed = false,
    }
    if ns.transportStats then
        ns.transportStats.downlinkCopy = stats
    end
    return stats
end
local function clone(value, depth, stats, owned)
    stats.deepNodes = stats.deepNodes + 1
    assert(depth <= 32, "Snapshot depth exceeded")
    if type(value) ~= "table" then
        if type(value) == "number" then
            assert(numbers.IsFinite(value), "Invalid number")
        else
            assert(
                value == nil or type(value) == "string" or type(value) == "boolean",
                "Invalid value"
            )
        end
        return value
    end
    local result = {}
    stats.deepTables = stats.deepTables + 1
    if owned then
        owned[result] = true
    end
    for key, entry in pairs(value) do
        assert((type(key) == "string" and not forbidden[key]) or integer(key, 1), "Invalid key")
        result[key] = clone(entry, depth + 1, stats, owned)
    end
    return result
end
local function keyFor(container, segment, append)
    assert(type(container) == "table", "Missing patch parent")
    if type(segment) == "string" then
        assert(not forbidden[segment], "Invalid patch key")
        for key in pairs(container) do
            assert(type(key) == "string", "Object path expected")
        end
        return segment
    end
    assert(integer(segment, 0), "Invalid array index")
    local length = #container
    for key in pairs(container) do
        assert(integer(key, 1) and key <= length, "Array path expected")
    end
    assert(segment < length or (append and segment == length), "Array index out of bounds")
    return segment + 1
end
local function arrayLength(value)
    assert(type(value) == "table", "Array expected")
    local length = #value
    for key in pairs(value) do
        assert(integer(key, 1) and key <= length, "Invalid array")
    end
    return length
end
function ns.Transport.ClearDownlink()
    baseline = nil
    baselineEpoch = baselineEpoch + 1
end
function ns.Transport.RememberDownlink(data)
    -- ApplyDownlink already holds a separate canonical candidate for this exact
    -- projection. Core can merge optimistic UI state without copying it again.
    if preparedProjection ~= nil and data == preparedProjection then
        return
    end
    local stats = copyStats("bulk")
    local remembered = clone(data, 0, stats)
    baseline = remembered
    baselineEpoch = baselineEpoch + 1
    stats.committed = true
end
function ns.Transport.ApplyDownlink(envelope)
    assert(type(envelope) == "table" and integer(envelope.r, 1), "Invalid snapshot revision")
    assert(preparedProjection == nil, "Snapshot receiver is already applying state")
    local result, projection
    local stats = copyStats(envelope.s ~= nil and "full" or "patch")
    if envelope.s ~= nil then
        assert(envelope.b == nil and envelope.p == nil, "Mixed snapshot envelope")
        -- The decoded message is fresh and can become the mutable UI projection.
        -- Keep a single defensive copy as canonical state, including when a
        -- caller retains or later modifies the decoded message itself.
        result = clone(envelope.s, 0, stats)
        projection = envelope.s
    else
        assert(integer(envelope.b, 1) and envelope.r > envelope.b, "Invalid patch revision")
        assert(baseline and baseline.rev == envelope.b, "Snapshot resynchronization required")
        assert(arrayLength(envelope.p) <= 4096, "Invalid patch operations")
        result = baseline
        local owned = {}
        local function writable(value)
            assert(type(value) == "table", "Missing patch parent")
            if owned[value] then
                return value
            end
            local copy = {}
            for key, entry in pairs(value) do
                copy[key] = entry
                stats.shallowEntries = stats.shallowEntries + 1
            end
            stats.shallowTables = stats.shallowTables + 1
            owned[copy] = true
            return copy
        end
        for _, operation in ipairs(envelope.p) do
            local arity = arrayLength(operation)
            local kind, path = operation[1], operation[2]
            assert(arrayLength(path) <= 32, "Patch path depth exceeded")
            assert(
                kind == "s" or kind == "d" or kind == "l" or kind == "a",
                "Unknown patch operation"
            )
            assert(arity == (kind == "d" and 2 or 3), "Invalid patch arity")
            if #path == 0 and kind == "s" then
                result = clone(operation[3], 0, stats, owned)
            else
                -- Detach only tables along the changed path. Unchanged branches
                -- stay shared with the immutable baseline until UI projection.
                result = writable(result)
                local parent = result
                for index = 1, #path - 1 do
                    local key = keyFor(parent, path[index], false)
                    local child = writable(parent[key])
                    parent[key] = child
                    parent = child
                end
                local key = #path > 0 and keyFor(parent, path[#path], kind == "s") or nil
                if kind == "s" then
                    parent[key] = clone(operation[3], #path, stats, owned)
                elseif kind == "d" then
                    assert(type(key) == "string" and parent[key] ~= nil, "Invalid object deletion")
                    parent[key] = nil
                elseif kind == "a" then
                    assert(
                        key ~= nil
                            and type(parent[key]) == "string"
                            and type(operation[3]) == "string",
                        "Invalid string append"
                    )
                    parent[key] = parent[key] .. operation[3]
                else
                    local target = key ~= nil and parent[key] or result
                    assert(
                        type(target) == "table" and integer(operation[3], 0),
                        "Invalid array length"
                    )
                    keyFor(target, #target, true)
                    assert(operation[3] <= #target, "Array extension is not a truncation")
                    target = writable(target)
                    if key ~= nil then
                        parent[key] = target
                    else
                        result = target
                    end
                    for index = #target, operation[3] + 1, -1 do
                        target[index] = nil
                    end
                end
            end
        end
    end
    assert(type(result) == "table" and result.rev == envelope.r, "Snapshot revision mismatch")
    assert(result.v == ns.VERSION and result.session == ns.session, "Snapshot session mismatch")
    assert(ns.Chat.ReceiveSnapshot, "Snapshot receiver unavailable")
    -- UI code mutates incoming chats/messages. A patch therefore needs one full
    -- mutable projection, rather than exposing shared canonical branches.
    projection = projection or clone(result, 0, stats)
    local epoch = baselineEpoch
    preparedProjection = projection
    local ok, reason = pcall(ns.Chat.ReceiveSnapshot, projection)
    preparedProjection = nil
    assert(ok, reason)
    assert(ns.rev == envelope.r, "Snapshot was not applied")
    assert(baselineEpoch == epoch, "Snapshot baseline changed while applying state")
    baseline = result
    baselineEpoch = baselineEpoch + 1
    stats.committed = true
end
