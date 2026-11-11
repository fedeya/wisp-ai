local _, ns = ...
local numbers = ns.Shared.Numbers

function numbers.IsFinite(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end

-- Zero is valid; caller-specific bounds (including JSON's safe range) stay local.
function numbers.IsNonNegativeInteger(value)
    return numbers.IsFinite(value) and value >= 0 and value % 1 == 0
end
