-- Syndicator readiness and read-only cached inventory adapter.
local _, ns = ...
local integer = ns.Shared.Numbers.IsNonNegativeInteger

function ns.Integrations._SyndicatorReport()
    local api = Syndicator and Syndicator.API
    local status = "missing"
    if api then
        status = "incompatible"
        if type(api.IsReady) == "function" and type(api.GetInventoryInfoByItemID) == "function" then
            local ok, ready = pcall(api.IsReady)
            status = ok and ready and "ready" or "waiting"
        end
    end
    return { status = status, version = api and ns.Integrations._AddonVersion("Syndicator") or nil }
end

function ns.Integrations.FindStoredItem(args)
    local api = Syndicator and Syndicator.API
    assert(
        api and api.IsReady and api.IsReady() and api.GetInventoryInfoByItemID,
        "Syndicator inventory API is not ready"
    )
    local data = api.GetInventoryInfoByItemID(args.itemId, true, true)
    assert(type(data) == "table", "Syndicator inventory data is unavailable")
    local matches, total = {}, 0
    for _, row in ipairs(data.characters or {}) do
        local counts, count = {}, 0
        for _, key in ipairs({ "bags", "bank", "mail", "equipped", "void", "auctions" }) do
            if integer(row[key]) then
                counts[key] = row[key]
                count = count + row[key]
            end
        end
        if count > 0 then
            total = total + count
            matches[#matches + 1] = {
                character = row.character,
                realm = row.realmNormalized,
                counts = counts,
                total = count,
            }
        end
    end
    if args.includeGuild then
        for _, row in ipairs(data.guilds or {}) do
            if integer(row.bank) and row.bank > 0 then
                total = total + row.bank
                matches[#matches + 1] = {
                    guild = row.guild,
                    realm = row.realmNormalized,
                    counts = { bank = row.bank },
                    total = row.bank,
                }
            end
        end
    end
    table.sort(matches, function(a, b)
        return (tostring(a.character or a.guild) .. "-" .. tostring(a.realm))
            < (tostring(b.character or b.guild) .. "-" .. tostring(b.realm))
    end)
    local owners = #matches
    while #matches > math.min(args.limit or 20, 40) do
        table.remove(matches)
    end
    return {
        status = "available",
        source = "Syndicator public API",
        version = "forever",
        itemId = args.itemId,
        matches = matches,
        totalCached = total,
        owners = owners,
        truncated = owners > #matches,
        cached = true,
        cacheAge = "unknown",
        scope = "visible characters on the current connected realm and faction",
        includesGuild = args.includeGuild == true,
        note = "Counts are cached observations; storage can be inaccessible or stale. Empty matches mean no cached match in this scope, not absence. Current bags should be verified through the live game API.",
    }
end
