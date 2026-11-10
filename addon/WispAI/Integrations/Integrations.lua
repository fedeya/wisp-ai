-- Shared helpers, readiness aggregation and protected inspection dispatch.
local _, ns = ...

function ns.Integrations._AddonVersion(name)
    local get = C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata
    return get and tostring(get(name, "Version") or "unknown"):sub(1, 80) or "unknown"
end

function ns.Integrations._IsInteger(value)
    return type(value) == "number"
        and value == value
        and value >= 0
        and value < math.huge
        and value % 1 == 0
end

function ns.Integrations.IntegrationReport()
    local clientVersion, clientBuild
    if GetBuildInfo then
        clientVersion, clientBuild = GetBuildInfo()
    end
    return {
        version = (tostring(clientVersion or "unknown") .. " (" .. tostring(
            clientBuild or "unknown"
        ) .. ")"):sub(1, 80),
        questie = ns.Integrations._QuestieReport(),
        syndicator = ns.Integrations._SyndicatorReport(),
        auctionator = ns.Integrations._AuctionatorReport(),
    }
end

function ns.Integrations.InspectIntegration(inspection)
    local readers = {
        questie_quest = ns.Integrations.ReadQuestieQuest,
        questie_chain = ns.Integrations.ReadQuestieChain,
        object_locations = ns.Integrations.FindObjectLocations,
        stored_item = ns.Integrations.FindStoredItem,
        item_prices = ns.Integrations.ReadAuctionatorPrices,
    }
    local reader = readers[inspection.kind]
    if not reader then
        return nil
    end
    local ok, data = pcall(reader, inspection.args or {})
    return {
        status = ok and "available" or "unavailable",
        data = ok and data or nil,
        error = not ok and tostring(data) or nil,
        capturedAt = time(),
    }
end
