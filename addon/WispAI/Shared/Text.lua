local _, ns = ...

-- Return a prefix within a non-negative integer byte limit and whether it was
-- truncated. Preserve UTF-8 character boundaries; this does not validate input.
function ns.Shared.Text.TruncateUtf8Bytes(value, bytes)
    if #value <= bytes then
        return value, false
    end
    local after = bytes + 1
    while after > 1 do
        local byte = value:byte(after)
        if byte < 128 or byte >= 192 then
            break
        end
        after = after - 1
    end
    return value:sub(1, after - 1), true
end
