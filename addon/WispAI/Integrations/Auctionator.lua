-- Auctionator readiness and read-only cached price adapter.
local _, ns = ...
local integer = ns.Integrations._IsInteger

function ns.Integrations._AuctionatorReport()
    local api = Auctionator and Auctionator.API and Auctionator.API.v1
    local status = Auctionator and "incompatible" or "missing"
    if api and type(api.GetAuctionPriceByItemID) == "function" then
        status = type(api.GetAuctionAgeByItemID) == "function" and "ready" or "partial"
    end
    return {
        status = status,
        version = Auctionator and ns.Integrations._AddonVersion("Auctionator") or nil,
    }
end

function ns.Integrations.ReadAuctionatorPrices(args)
    local api = Auctionator and Auctionator.API and Auctionator.API.v1
    assert(api and api.GetAuctionPriceByItemID, "Auctionator price API is unavailable")
    local prices, seen = {}, {}
    for _, id in ipairs(args.itemIds or {}) do
        if not seen[id] then
            seen[id] = true
            local price = api.GetAuctionPriceByItemID("WispAI", id)
            local age = api.GetAuctionAgeByItemID and api.GetAuctionAgeByItemID("WispAI", id)
            local known = integer(price) and price > 0
            prices[#prices + 1] = {
                itemId = id,
                status = known and "available" or "unknown",
                unitPriceCopper = known and price or nil,
                ageDays = known and integer(age) and age or nil,
                ageKnown = known and integer(age) or false,
            }
        end
    end
    return {
        status = "available",
        source = "Auctionator public API",
        version = "forever",
        realm = GetRealmName(),
        faction = UnitFactionGroup("player"),
        prices = prices,
        cached = true,
        note = "Last-seen unit prices in copper, not live listings or sale guarantees. Age is whole days, not an exact timestamp. Missing prices/ages are unknown. No search, scan, purchase or posting was performed.",
    }
end
