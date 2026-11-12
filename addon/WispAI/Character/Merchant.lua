local _, ns = ...
-- Serialized offers, including JSON escaping. Leave >17 KiB below the wire
-- ceiling for observation/packet metadata and zlib's incompressible overhead.
local MAX_OFFER_JSON_BYTES = 48000
local open, merchantGUID, revision = false, nil, 0
local events = CreateFrame("Frame")
for _, event in ipairs({
    "MERCHANT_SHOW",
    "MERCHANT_CLOSED",
    "MERCHANT_UPDATE",
    "PLAYER_ENTERING_WORLD",
}) do
    events:RegisterEvent(event)
end
events:SetScript("OnEvent", function(_, event)
    revision = revision + 1
    if event == "MERCHANT_SHOW" then
        open = true
        merchantGUID = UnitGUID("npc")
    elseif event ~= "MERCHANT_UPDATE" then
        open, merchantGUID = false, nil
    end
end)

local function integer(value, minimum)
    return type(value) == "number"
        and ns.Shared.Numbers.IsFinite(value)
        and value >= minimum
        and value <= 9007199254740991
        and value == math.floor(value)
end
local function text(value, limit)
    if type(value) == "string" then
        return ns.Shared.Text.TruncateUtf8Bytes(value, limit)
    end
end
local function boolean(value)
    if type(value) == "boolean" then
        return value
    end
end

local function id(value)
    local number = tonumber(value)
    return integer(number, 1) and number or nil
end

local function requirements(index)
    if not C_TooltipInfo or not C_TooltipInfo.GetMerchantItem then
        return nil
    end
    local ok, info = pcall(C_TooltipInfo.GetMerchantItem, index)
    if not ok or type(info) ~= "table" or type(info.lines) ~= "table" then
        return nil
    end
    local lines, truncated = {}, #info.lines > 12
    for i = 1, math.min(#info.lines, 12) do
        local line = info.lines[i]
        if type(line) == "table" then
            local left, leftClipped = text(line.leftText, 256)
            local right, rightClipped = text(line.rightText, 256)
            lines[#lines + 1] = { left = left, right = right }
            truncated = truncated or leftClipped == true or rightClipped == true
        end
    end
    return lines, truncated
end

-- A fresh, bounded observation of the current merchant's filtered offer list.
-- Never retain offers, navigate pages, or perform a purchase.
function ns.Character.ReadMerchant(args)
    assert(open and merchantGUID, "Open a merchant window first")
    assert(MerchantFrame and MerchantFrame:IsShown(), "Merchant window is closed")
    assert(MerchantFrame.selectedTab == 1, "Select the merchant offers tab first")
    assert(UnitGUID("npc") == merchantGUID, "Merchant changed; reopen the merchant window")
    assert(
        GetMerchantNumItems and GetMerchantItemInfo and GetMerchantItemLink,
        "Merchant API is unavailable"
    )
    local offset, limit = args.offset or 0, args.limit or 20
    assert(
        integer(offset, 0) and offset <= 500 and integer(limit, 1) and limit <= 40,
        "Invalid merchant bounds"
    )
    local count = GetMerchantNumItems()
    assert(integer(count, 0), "Merchant offer count is unavailable")
    local capturedRevision, capturedGUID = revision, merchantGUID
    local offers, incomplete = {}, false
    local offerBytes = 2 -- array delimiters
    for index = offset + 1, math.min(count, offset + limit, 540) do
        local ok, name, _, price, bundle, stock, purchasable, usable, extended, currency =
            pcall(GetMerchantItemInfo, index)
        local offer = {
            index = index,
            status = "unavailable",
            costStatus = "unknown",
            stockStatus = "unknown",
        }
        if ok and type(name) == "string" then
            offer.status, offer.name = "available", text(name, 200)
            local linkOK, link = pcall(GetMerchantItemLink, index)
            offer.link = linkOK and text(link, 512) or nil
            offer.itemId = offer.link and id(offer.link:match("item:(%d+)")) or nil
            offer.bundleSize = integer(bundle, 1) and bundle or nil
            offer.isPurchasable, offer.isUsable = boolean(purchasable), boolean(usable)
            if stock == -1 then
                offer.stockStatus = "unlimited"
            elseif integer(stock, 0) then
                offer.stockStatus, offer.availableCount = "limited", stock
            end
            if extended == true or (integer(currency, 1)) then
                offer.costStatus = "unsupported"
            elseif
                extended == false
                and (currency == nil or currency == 0)
                and integer(price, 0)
            then
                offer.costStatus, offer.costCopper = "copper", price
            end
            offer.tooltip, offer.tooltipTruncated = requirements(index)
            offer.requirementsStatus = offer.tooltip and "available" or "unavailable"
            incomplete = incomplete
                or not offer.itemId
                or not offer.bundleSize
                or offer.costStatus ~= "copper"
                or offer.stockStatus == "unknown"
        else
            incomplete = true
        end
        local bytes = #C_EncodingUtil.SerializeJSON(offer) + 1
        if offerBytes + bytes > MAX_OFFER_JSON_BYTES and offer.tooltip then
            offer.tooltip = nil
            offer.tooltipTruncated = true
            offer.requirementsStatus = "unavailable"
            bytes = #C_EncodingUtil.SerializeJSON(offer) + 1
        end
        if offerBytes + bytes > MAX_OFFER_JSON_BYTES then
            break
        end
        offerBytes = offerBytes + bytes
        offers[#offers + 1] = offer
    end
    assert(
        open
            and revision == capturedRevision
            and UnitGUID("npc") == capturedGUID
            and MerchantFrame:IsShown()
            and MerchantFrame.selectedTab == 1,
        "Merchant changed during capture; retry"
    )
    return {
        merchant = {
            name = text(UnitName("npc"), 200),
            guid = text(capturedGUID, 128),
            npcId = id(capturedGUID:match("^Creature%-%d+%-%d+%-%d+%-%d+%-(%d+)%-")),
        },
        sessionRevision = capturedRevision,
        capturedAt = time(),
        source = "WoW Forever current merchant API",
        offers = offers,
        totalVisibleOffers = count,
        offset = offset,
        truncated = offset > 0 or offset + #offers < count,
        partial = true,
        incomplete = incomplete,
        note = "Current filtered offers only, not all vendor stock. Prices are copper per purchase bundle; stock is item count. Requirements are bounded raw tooltip text, not inferred eligibility; usability/purchasability are only exposed flags. Extended costs are unsupported. Re-read after close, merchant change or stock update; historical results are not live facts. No purchase was performed.",
    }
end
