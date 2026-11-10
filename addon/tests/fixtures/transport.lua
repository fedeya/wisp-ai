now = 0
loads = 0
packets = {}
timers = {}
logs = {}
states, disk = {}, {}
for index = 1, 128 do
    local name = string.format("WispAI_B%03d", index)
    states[name], disk[name] = true, true
end
for index = 1, 1024 do
    local name = string.format("WispAI_S%04d", index)
    states[name], disk[name] = true, true
end
bit = {
    bxor = function(a, b)
        return a ~ b
    end,
    band = function(a, b)
        return a & b
    end,
    rshift = function(a, b)
        return a >> b
    end,
}
ns = {
    session = "game",
    rev = 0,
    connected = false,
    SLOTS = 1024,
    chats = { { status = "idle" } },
    active = "chat",
    Core = {},
    Chat = {},
    Transport = {},
    Character = {},
    Actions = {},
    Integrations = {},
    ChatHistory = {},
    Settings = {},
    UI = {},
    Inline = {},
    Panels = {},
    Advice = {},
}
function time()
    return 123
end
function GetTime()
    return now
end
function UnitGUID(unit)
    assert(unit == "player")
    return "Player-Test-GUID"
end
function ns.Core.Log(text)
    logs[#logs + 1] = text
end
Enum = { CompressionMethod = { Zlib = 1 } }
C_EncodingUtil = {
    SerializeJSON = function(packet)
        packets[#packets + 1] = packet
        return "{}"
    end,
    CompressString = function(text)
        return text
    end,
    DeserializeJSON = function(text)
        local revision = text:match('^%{"r":(%d+)%}$')
        assert(revision, "Expected a checked readiness notification")
        return { r = tonumber(revision) }
    end,
}
C_Timer = {
    NewTicker = function(seconds, fn)
        timers[seconds] = fn
        return { Cancel = function() end }
    end,
}
C_AddOns = {
    DoesAddOnExist = function()
        return true
    end,
    GetAddOnEnableState = function(name, character)
        assert(character == "Player-Test-GUID")
        return states[name] and 2 or 0
    end,
    EnableAddOn = function(name, character)
        assert(character == "Player-Test-GUID")
        states[name] = true
    end,
    DisableAddOn = function(name, character)
        assert(character == "Player-Test-GUID")
        states[name] = false
    end,
    ResetAddOns = function()
        for name, value in pairs(disk) do
            states[name] = value
        end
    end,
    SaveAddOns = function()
        for name, value in pairs(states) do
            disk[name] = value
        end
    end,
    LoadAddOn = function()
        loads = loads + 1
        if nextRev then
            ns.rev = nextRev
            nextRev = nil
            if nextConnected == nil then
                ns.connected = true
            else
                ns.connected = nextConnected
                nextConnected = nil
            end
            ns.Transport.Acknowledge({ 1 })
        end
        return true
    end,
}
function PlaySoundFile()
    return true, 1
end
function StopSound() end
