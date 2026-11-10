-- Report public API readiness, not copies of addon data.
local _, ns = ...
local function version(name)
    local get = C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata
    return get and tostring(get(name, "Version") or "unknown"):sub(1, 80) or "unknown"
end
local function reads(entity)
    return entity and type(entity.Get) == "function" and type(entity.Exists) == "function" or false
end
local function syndicatorReport()
    local api = Syndicator and Syndicator.API
    local status = "missing"
    if api then
        status = "incompatible"
        if type(api.IsReady) == "function" and type(api.GetInventoryInfoByItemID) == "function" then
            local ok, ready = pcall(api.IsReady)
            status = ok and ready and "ready" or "waiting"
        end
    end
    return { status = status, version = api and version("Syndicator") or nil }
end
local function auctionatorReport()
    local api = Auctionator and Auctionator.API and Auctionator.API.v1
    local status = Auctionator and "incompatible" or "missing"
    if api and type(api.GetAuctionPriceByItemID) == "function" then
        status = type(api.GetAuctionAgeByItemID) == "function" and "ready" or "partial"
    end
    return { status = status, version = Auctionator and version("Auctionator") or nil }
end
function ns.Integrations.IntegrationReport()
    local db = LibQuestieDB
    local status, trainers, services, npcs, quests, objects =
        "missing", false, false, false, false, false
    if db then
        status = "incompatible"
        local ok, compatible = pcall(function()
            return db.flavor
                and db.flavor.expansion == "Forever"
                and db.RequireContract
                and db.RequireContract(4)
        end)
        if ok and compatible then
            npcs, quests, objects = reads(db.Npc), reads(db.Quest), reads(db.Object)
            status = (npcs or quests or objects) and "partial" or "incompatible"
            if Questie and Questie.IsForever and QuestieLoader and QuestieLoader.ImportModule then
                local loaded, townsfolk =
                    pcall(QuestieLoader.ImportModule, QuestieLoader, "Townsfolk")
                if loaded and townsfolk then
                    trainers = type(townsfolk.GetClassTrainers) == "function"
                    services = type(townsfolk.townsfolk) == "table"
                end
            end
            if npcs and quests and objects and trainers and services then
                status = "ready"
            end
        end
    end
    local clientVersion, clientBuild
    if GetBuildInfo then
        clientVersion, clientBuild = GetBuildInfo()
    end
    return {
        version = (tostring(clientVersion or "unknown") .. " (" .. tostring(
            clientBuild or "unknown"
        ) .. ")"):sub(1, 80),
        questie = {
            status = status,
            version = db and version("QuestieDB") or nil,
            npcs = npcs,
            quests = quests,
            objects = objects,
            trainers = trainers,
            services = services,
        },
        syndicator = syndicatorReport(),
        auctionator = auctionatorReport(),
    }
end
