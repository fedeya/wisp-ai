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
        GetMerchantItemInfo = nil
        C_MerchantFrame = {
            GetItemInfo = function(i)
                return {
                    name = "Supply",
                    price = i == 3 and 0 or 120,
                    stackCount = 5,
                    numAvailable = i == 2 and 0 or -1,
                    isPurchasable = true,
                    isUsable = false,
                    hasExtendedCost = i == 3,
                }
            end,
        }
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
        env.C_MerchantFrame.GetItemInfo = function()
            return { name = "Unknown" }
        end
        local unknown = read().data.offers[1]
        assert.equals("unknown", unknown.costStatus)
        assert.equals("unknown", unknown.stockStatus)
        assert.is_nil(unknown.isUsable)
        assert.is_nil(unknown.bundleSize)
        assert.equals("unavailable", read({ limit = 41 }).status)
        env.C_MerchantFrame.GetItemInfo = function()
            error("restricted")
        end
        assert.equals("unavailable", read().data.offers[1].status)
    end)

    it("rejects mid-capture changes, hidden/buyback windows and unavailable APIs", function()
        fire("MERCHANT_SHOW")
        env.C_MerchantFrame.GetItemInfo = function()
            fire("MERCHANT_UPDATE")
            return {
                name = "Changed",
                price = 1,
                stackCount = 1,
                numAvailable = -1,
                hasExtendedCost = false,
            }
        end
        assert.equals("unavailable", read().status)
        env.MerchantFrame.selectedTab = 2
        assert.equals("unavailable", read().status)
        env.MerchantFrame.selectedTab = 1
        env.C_MerchantFrame = nil
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
        env.C_MerchantFrame.GetItemInfo = function()
            calls = calls + 1
            return {
                name = string.rep("é", 300),
                price = 0 / 0,
                stackCount = 5,
                numAvailable = 3,
                isPurchasable = false,
                isUsable = false,
                hasExtendedCost = false,
            }
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
            env.C_MerchantFrame.GetItemInfo = function()
                return {
                    name = "Free",
                    price = 0,
                    stackCount = 5,
                    numAvailable = 8,
                    isPurchasable = true,
                    isUsable = true,
                    hasExtendedCost = false,
                }
            end
            local offer = read().data.offers[1]
            assert.is_nil(offer.itemId)
            assert.equals("copper", offer.costStatus)
            assert.equals(0, offer.costCopper)
            assert.equals(1, math.floor(offer.availableCount / offer.bundleSize))
        end
    )

    it("uses only the current struct API and preserves the exact variant link", function()
        local oldCalls = 0
        env.GetMerchantItemInfo = function()
            oldCalls = oldCalls + 1
            error("removed API must never be called")
        end
        local link = "|cffa335ee|Hitem:123:7:0:0:0:0:99:0:80:0:0:2:42:17|h[Variant]|h|r"
        env.GetMerchantItemLink = function()
            return link
        end
        fire("MERCHANT_SHOW")
        local result = read({ limit = 1 })
        assert.equals("available", result.status)
        assert.same({ "Supply", 120, 5, "unlimited", true, false, link, 123 }, {
            result.data.offers[1].name,
            result.data.offers[1].costCopper,
            result.data.offers[1].bundleSize,
            result.data.offers[1].stockStatus,
            result.data.offers[1].isPurchasable,
            result.data.offers[1].isUsable,
            result.data.offers[1].link,
            result.data.offers[1].itemId,
        })
        assert.equals(0, oldCalls)
    end)

    it(
        "keeps no-return, restricted and malformed records unavailable without defaulting prices",
        function()
            fire("MERCHANT_SHOW")
            local readers = {
                function() end,
                function()
                    error("restricted")
                end,
                function()
                    return false
                end,
                function()
                    return "not a struct"
                end,
                function()
                    return { name = 123 }
                end,
                function()
                    return {}
                end,
                function()
                    return setmetatable({}, {
                        __index = function()
                            error("restricted field")
                        end,
                    })
                end,
            }
            for _, reader in ipairs(readers) do
                env.C_MerchantFrame.GetItemInfo = reader
                local result = read({ limit = 1 })
                assert.equals("available", result.status)
                local offer = result.data.offers[1]
                assert.equals("unavailable", offer.status)
                assert.equals("unknown", offer.costStatus)
                assert.is_nil(offer.costCopper)
                assert.is_nil(offer.bundleSize)
                assert.is_true(result.data.incomplete)
            end
            for _, namespace in ipairs({ false, {}, { GetItemInfo = true } }) do
                env.C_MerchantFrame = namespace
                assert.equals("unavailable", read().status)
            end
            env.C_MerchantFrame = nil
            assert.equals("unavailable", read().status)
        end
    )

    it(
        "rejects secret or malformed fields independently before comparison or serialization",
        function()
            fire("MERCHANT_SHOW")
            local secret = setmetatable({}, {
                __index = function()
                    error("secret was indexed")
                end,
                __tostring = function()
                    error("secret was stringified")
                end,
            })
            env.issecretvalue = function(value)
                return rawequal(value, secret)
            end
            local valid = {
                name = "Supply",
                price = 120,
                stackCount = 5,
                numAvailable = 10,
                isPurchasable = false,
                isUsable = false,
                hasExtendedCost = false,
            }
            for _, key in ipairs({
                "price",
                "stackCount",
                "numAvailable",
                "isPurchasable",
                "isUsable",
                "hasExtendedCost",
                "currencyID",
            }) do
                for _, bad in ipairs({ secret, "malformed" }) do
                    local info = {}
                    for k, v in pairs(valid) do
                        info[k] = v
                    end
                    info[key] = bad
                    env.C_MerchantFrame.GetItemInfo = function()
                        return info
                    end
                    local offer = read({ limit = 1 }).data.offers[1]
                    assert.equals("available", offer.status)
                    if key == "price" or key == "hasExtendedCost" or key == "currencyID" then
                        assert.equals("unknown", offer.costStatus)
                        assert.is_nil(offer.costCopper)
                    elseif key == "stackCount" then
                        assert.is_nil(offer.bundleSize)
                    elseif key == "numAvailable" then
                        assert.equals("unknown", offer.stockStatus)
                        assert.is_nil(offer.availableCount)
                    else
                        assert.is_nil(offer[key])
                    end
                end
            end
            env.C_MerchantFrame.GetItemInfo = function()
                return secret
            end
            assert.equals("unavailable", read().data.offers[1].status)
            env.C_MerchantFrame.GetItemInfo = function()
                return { name = secret }
            end
            assert.equals("unavailable", read().data.offers[1].status)
            env.C_MerchantFrame.GetItemInfo = function()
                return valid
            end
            env.GetMerchantItemLink = function()
                return secret
            end
            local unlinked = read().data.offers[1]
            assert.equals("available", unlinked.status)
            assert.is_nil(unlinked.link)
            assert.is_nil(unlinked.itemId)
            env.C_MerchantFrame.GetItemInfo = function()
                return setmetatable({ name = "Readable", stackCount = 5, numAvailable = -1 }, {
                    __index = function()
                        error("restricted field")
                    end,
                })
            end
            local offer = read().data.offers[1]
            assert.equals("available", offer.status)
            assert.equals("unknown", offer.costStatus)
            assert.equals(5, offer.bundleSize)
            assert.equals("unlimited", offer.stockStatus)
        end
    )

    it("maps current currency and zero values without filling undocumented missing data", function()
        fire("MERCHANT_SHOW")
        local info = {
            name = "Offer",
            price = 0,
            stackCount = 5,
            numAvailable = 0,
            isPurchasable = false,
            isUsable = false,
            hasExtendedCost = false,
            currencyID = 0,
        }
        env.C_MerchantFrame.GetItemInfo = function()
            return info
        end
        local offer = read().data.offers[1]
        assert.equals("copper", offer.costStatus)
        assert.equals(0, offer.costCopper)
        assert.equals("limited", offer.stockStatus)
        assert.equals(0, offer.availableCount)
        assert.is_false(offer.isPurchasable)
        info.currencyID = 81
        offer = read().data.offers[1]
        assert.equals("unsupported", offer.costStatus)
        assert.is_nil(offer.costCopper)
        info.currencyID = nil
        info.stackCount = 0
        info.price = nil
        info.numAvailable = nil
        offer = read().data.offers[1]
        assert.equals("unknown", offer.costStatus)
        assert.equals("unknown", offer.stockStatus)
        assert.is_nil(offer.costCopper)
        assert.is_nil(offer.availableCount)
        assert.is_nil(offer.bundleSize)
    end)
end)
