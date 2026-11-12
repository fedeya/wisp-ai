local helper = require("addon.tests.support")
local assert = require("luassert")

it("reads loaded mail through Inspect without exposing private fields or changing mail", function()
    local env = helper.env()
    setfenv(1, env)
    ns = helper.namespace()
    local callback
    CreateFrame = function()
        return {
            RegisterEvent = function() end,
            SetScript = function(_, _, fn)
                callback = callback or fn
            end,
        }
    end
    time = function()
        return 123
    end
    UnitName = function()
        return "Mage"
    end
    C_EncodingUtil = {
        SerializeJSON = function()
            return "fixture"
        end,
    }
    MailFrame = {
        IsShown = function()
            return true
        end,
    }
    GetInboxNumItems = function()
        return 3, 8
    end
    GetInboxHeaderInfo = function(i)
        local expiry = i * 2
        if i == 3 then
            expiry = nil
        end
        return nil,
            nil,
            "PRIVATE_SENDER",
            "PRIVATE_SUBJECT",
            i == 2 and 12345 or 0,
            i == 3 and 500 or 0,
            expiry,
            1,
            nil,
            nil,
            nil,
            nil,
            nil,
            nil,
            "|Hitem:2589::::::::|h[Cloth]|h"
    end
    HasInboxItem = function(_, slot)
        return slot == 1
    end
    GetInboxItem = function(i)
        return "Cloth", 2589, nil, i * 5, nil, nil, false
    end
    for _, name in ipairs({
        "GetInboxText",
        "CheckInbox",
        "TakeInboxItem",
        "TakeInboxMoney",
        "DeleteInboxItem",
        "ReturnInboxItem",
        "SendMail",
        "InboxFrame_OnClick",
    }) do
        env[name] = function()
            error("forbidden " .. name)
        end
    end
    helper.addon("Shared/Numbers.lua", env)
    helper.addon("Shared/Text.lua", env)
    helper.addon("Character/Mail.lua", env)
    helper.addon("Character/Inspect.lua", env)
    local result = ns.Character.Inspect({ kind = "mail", args = { limit = 10 } })
    assert.equals("available", result.status)
    local data = result.data
    assert.equals(3, data.loadedCount)
    assert.equals(8, data.totalCount)
    assert.is_true(data.partial)
    assert.equals(5, data.rows[1].attachments[1].quantity)
    assert.equals(12345, data.rows[2].moneyCopper)
    assert.equals(500, data.rows[3].codCopper)
    assert.equals("unknown", data.rows[3].fields.expiry)
    assert.equals(2, data.rows[1].expiryDays)
    assert.equals(4, data.rows[2].expiryDays)
    assert.equals("|Hitem:2589::::::::|h[Cloth]|h", data.rows[1].attachments[1].link)
    assert.is_nil(data.rows[1].subject)
    assert.is_nil(data.rows[1].sender)
    local originalHeader = GetInboxHeaderInfo
    for _, bad in ipairs({ -1, "5", math.huge, 0 / 0, {} }) do
        GetInboxHeaderInfo = function()
            return nil, nil, nil, nil, bad, bad, bad, bad
        end
        local observation = ns.Character.Inspect({ kind = "mail", args = {} }).data
        assert.is_true(observation.partial)
        assert.is_nil(observation.rows[1].moneyCopper)
        assert.is_nil(observation.rows[1].codCopper)
        assert.is_nil(observation.rows[1].expiryDays)
        assert.is_nil(observation.rows[1].attachmentCount)
    end
    GetInboxHeaderInfo = originalHeader
    local originalItem = GetInboxItem
    issecretvalue = function(value)
        return value == 2589
    end
    assert.is_nil(
        ns.Character.Inspect({ kind = "mail", args = {} }).data.rows[1].attachments[1].itemId
    )
    issecretvalue = nil
    HasInboxItem = nil
    local unknown = ns.Character.Inspect({ kind = "mail", args = {} }).data.rows[1]
    assert.equals(16, unknown.unknownSlots)
    assert.equals(16, #unknown.unknownSlotPositions)
    assert.equals("partial", unknown.attachmentsStatus)
    HasInboxItem = function(_, slot)
        return slot == 1
    end
    GetInboxItem = nil
    assert.equals(
        "unknown",
        ns.Character.Inspect({ kind = "mail", args = {} }).data.rows[1].attachments[1].quantityStatus
    )
    GetInboxItem = originalItem
    local reads = 0
    GetInboxItem = function(i)
        reads = reads + 1
        return "Cloth", 2589, nil, reads > 3 and 999 or i * 5, nil, nil, false
    end
    assert.equals("unavailable", ns.Character.Inspect({ kind = "mail", args = {} }).status)
    GetInboxItem = originalItem
    GetInboxNumItems = function()
        return 0, 8
    end
    local empty = ns.Character.Inspect({ kind = "mail", args = {} }).data
    assert.equals(0, empty.loadedCount)
    assert.is_true(empty.partial)
    GetInboxNumItems = function()
        return nil, nil
    end
    local missing = ns.Character.Inspect({ kind = "mail", args = {} }).data
    assert.is_nil(missing.loadedCount)
    assert.is_true(missing.partial)
    GetInboxNumItems = function()
        return 3, 8
    end
    assert.equals(
        "unavailable",
        ns.Character.Inspect({ kind = "mail", args = { includeBodies = true } }).status
    )
    assert.equals(
        "unavailable",
        ns.Character.Inspect({ kind = "mail", args = { limit = 51 } }).status
    )
    GetInboxItem = function()
        callback(nil, "MAIL_CLOSED")
        return "Cloth", 2589, nil, 5
    end
    assert.equals("unavailable", ns.Character.Inspect({ kind = "mail", args = {} }).status)
end)
