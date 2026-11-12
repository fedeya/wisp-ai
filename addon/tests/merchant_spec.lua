local helper = require("addon.tests.support")

describe("current merchant inspection", function()
    local env, events, guid
    before_each(function()
        env = helper.env()
        setfenv(1, env)
        -- Wire sizing uses real JSON/zlib in merchant-transport.test.ts.
        C_EncodingUtil = {
            SerializeJSON = function()
                return "{}"
            end,
        }
        ns = helper.namespace()
        events = {}
        guid = "Creature-0-0-0-0-123-0"
        CreateFrame = function()
            return {
                RegisterEvent = function() end,
                SetScript = function(_, _, callback)
                    events[#events + 1] = callback
                end,
            }
        end
        time = function()
            return 123
        end
        UnitName = function()
            return "Supplier"
        end
        UnitGUID = function()
            return guid
        end
        MerchantFrame = {
            IsShown = function()
                return true
            end,
            selectedTab = 1,
        }
        GetMerchantNumItems = function()
            return 3
        end
        GetMerchantItemInfo = function(i)
            return "Supply", nil, i == 3 and 0 or 120, 5, i == 2 and 0 or -1, true, false, i == 3
        end
        GetMerchantItemLink = function(i)
            return "item:" .. i
        end
        GetMoney = function()
            return 500
        end
        NUM_BAG_SLOTS = 0
        C_Container = {
            GetContainerNumSlots = function()
                return 16
            end,
        }
        ns.Character.ReadBags = function()
            return { items = {} }
        end
        helper.addon("Character/Merchant.lua", env)
        helper.addon("Character/Inspect.lua", env)
    end)

    local function fire(event)
        for _, callback in ipairs(events) do
            callback(nil, event)
        end
    end
    local function read(args)
        return env.ns.Character.Inspect({ kind = "merchant", args = args or {} })
    end

    it(
        "composes fresh resources with bundle costs without treating unsupported offers as free",
        function()
            fire("MERCHANT_SHOW")
            local result = read()
            assert.equals("available", result.status)
            local data = result.data
            assert.equals(123, result.capturedAt)
            assert.equals(123, data.merchant.npcId)
            assert.is_true(data.partial)
            assert.equals("unlimited", data.offers[1].stockStatus)
            assert.is_false(data.offers[1].isUsable)
            assert.equals(0, data.offers[2].availableCount)
            assert.equals("unsupported", data.offers[3].costStatus)
            assert.is_nil(data.offers[3].costCopper)
            local resources = env.ns.Character.Inspect({ kind = "resources" }).data
            local budget = math.min(300, resources.moneyCopper)
            local offer = data.offers[1]
            local purchases = math.floor(budget / offer.costCopper)
            assert.equals(10, purchases * offer.bundleSize)
            assert.equals(260, resources.moneyCopper - purchases * offer.costCopper)
            assert.equals(0, math.min(purchases, data.offers[2].availableCount))
            -- Unknown costs cannot participate in an exact complete shopping total.
            assert.is_nil(data.offers[3].costCopper)
        end
    )

    it("invalidates close and identity changes, never serving old offers", function()
        assert.equals("unavailable", read().status)
        fire("MERCHANT_SHOW")
        assert.equals("available", read().status)
        guid = "Creature-0-0-0-0-456-0"
        assert.equals("unavailable", read().status)
        fire("MERCHANT_SHOW")
        assert.equals(456, read().data.merchant.npcId)
        fire("MERCHANT_CLOSED")
        assert.equals("unavailable", read().status)
    end)

    it("bounds rows and visible requirement text and preserves missing fields", function()
        fire("MERCHANT_SHOW")
        env.C_TooltipInfo = {
            GetMerchantItem = function()
                return { lines = { { leftText = "Requires Level 10", rightText = "Mage" } } }
            end,
        }
        local data = read({ limit = 1 }).data
        assert.equals(1, #data.offers)
        assert.is_true(data.truncated)
        assert.equals("Requires Level 10", data.offers[1].tooltip[1].left)
        assert.equals("available", data.offers[1].requirementsStatus)
        env.GetMerchantItemInfo = function()
            return "Unknown", nil, nil, nil, nil
        end
        local unknown = read().data.offers[1]
        assert.equals("unknown", unknown.costStatus)
        assert.equals("unknown", unknown.stockStatus)
        assert.is_nil(unknown.isUsable)
        assert.is_nil(unknown.bundleSize)
        assert.equals("unavailable", read({ limit = 41 }).status)
        env.GetMerchantItemInfo = function()
            error("restricted")
        end
        assert.equals("unavailable", read().data.offers[1].status)
    end)

    it("rejects mid-capture changes, hidden/buyback windows and unavailable APIs", function()
        fire("MERCHANT_SHOW")
        env.GetMerchantItemInfo = function()
            fire("MERCHANT_UPDATE")
            return "Changed", nil, 1, 1, -1, true, true, false
        end
        assert.equals("unavailable", read().status)
        env.MerchantFrame.selectedTab = 2
        assert.equals("unavailable", read().status)
        env.MerchantFrame.selectedTab = 1
        env.GetMerchantItemInfo = nil
        assert.equals("unavailable", read().status)
        fire("PLAYER_ENTERING_WORLD")
        assert.equals("unavailable", read().status)
    end)

    it("bounds scans and text and never invents zero for unreadable prices", function()
        fire("MERCHANT_SHOW")
        local calls = 0
        env.GetMerchantNumItems = function()
            return 1000
        end
        env.GetMerchantItemInfo = function()
            calls = calls + 1
            return string.rep("é", 300), nil, 0 / 0, 5, 3, false, false, false
        end
        local data = read({ offset = 500, limit = 40 }).data
        assert.equals(40, calls)
        assert.equals(40, #data.offers)
        assert.equals(501, data.offers[1].index)
        assert.equals(200, #data.offers[1].name)
        assert.equals("unknown", data.offers[1].costStatus)
        assert.is_nil(data.offers[1].costCopper)
        assert.equals(3, data.offers[1].availableCount)
        assert.is_false(data.offers[1].isPurchasable)
        assert.is_true(data.truncated)
    end)

    it("reports either clipped column and row limits without splitting UTF-8 bytes", function()
        fire("MERCHANT_SHOW")
        for _, column in ipairs({ "leftText", "rightText" }) do
            for _, value in ipairs({ string.rep("x", 300), string.rep("界", 100) }) do
                env.C_TooltipInfo = {
                    GetMerchantItem = function()
                        return { lines = { { [column] = value } } }
                    end,
                }
                local offer = read({ limit = 1 }).data.offers[1]
                local clipped = offer.tooltip[1][column == "leftText" and "left" or "right"]
                assert.equals(value:sub(1, value:sub(1, 1) == "x" and 256 or 255), clipped)
                assert.is_true(offer.tooltipTruncated)
            end
        end
        env.C_TooltipInfo.GetMerchantItem = function()
            local lines = {}
            for i = 1, 13 do
                lines[i] = { leftText = "short" }
            end
            return { lines = lines }
        end
        local offer = read({ limit = 1 }).data.offers[1]
        assert.equals(12, #offer.tooltip)
        assert.is_true(offer.tooltipTruncated)
        env.C_TooltipInfo.GetMerchantItem = function()
            return { lines = { { leftText = "short", rightText = "界" } } }
        end
        assert.is_false(read({ limit = 1 }).data.offers[1].tooltipTruncated)
    end)

    it(
        "does not serialize unbounded IDs as infinity or confuse a free bundle with unknown cost",
        function()
            fire("MERCHANT_SHOW")
            env.GetMerchantItemLink = function()
                return "item:" .. string.rep("9", 400)
            end
            env.GetMerchantItemInfo = function()
                return "Free", nil, 0, 5, 8, true, true, false
            end
            local offer = read().data.offers[1]
            assert.is_nil(offer.itemId)
            assert.equals("copper", offer.costStatus)
            assert.equals(0, offer.costCopper)
            assert.equals(1, math.floor(offer.availableCount / offer.bundleSize))
        end
    )
end)
