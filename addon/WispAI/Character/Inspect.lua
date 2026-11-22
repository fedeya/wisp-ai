local _, ns = ...
local inspectors = {}
local function tooltip(link)
    if not C_TooltipInfo or not C_TooltipInfo.GetHyperlink then
        return nil
    end
    local ok, info = pcall(C_TooltipInfo.GetHyperlink, link)
    if not ok or not info then
        return nil
    end
    local lines = {}
    for _, line in ipairs(info.lines or {}) do
        if line.leftText or line.rightText then
            lines[#lines + 1] = { left = line.leftText, right = line.rightText }
        end
    end
    return lines
end
local function itemDetails(id)
    assert(C_Item and C_Item.GetItemInfo, "Item API is unavailable")
    local name, link, quality, level, requiredLevel, class, subclass, stackSize, equipLocation, _, vendorPrice =
        C_Item.GetItemInfo(id)
    if not name then
        if C_Item.RequestLoadItemDataByID then
            C_Item.RequestLoadItemDataByID(id)
        end
        return {
            id = id,
            status = "loading",
            note = "Item data is not cached. Retry after the client loads it.",
        }
    end
    local stats = C_Item.GetItemStats and C_Item.GetItemStats(link)
    return {
        id = id,
        status = "available",
        name = name,
        link = link,
        quality = quality,
        itemLevel = level,
        requiredLevel = requiredLevel,
        class = class,
        subclass = subclass,
        stackSize = stackSize,
        equipLocation = equipLocation,
        vendorPriceCopper = vendorPrice,
        stats = stats,
        statsStatus = stats and "available" or "unavailable",
        tooltip = tooltip(link),
    }
end

local function readPublic(fn, ...)
    if type(fn) ~= "function" then
        return
    end
    local ok, a, b, c = pcall(fn, ...)
    if
        ok and (not issecretvalue or not (issecretvalue(a) or issecretvalue(b) or issecretvalue(c)))
    then
        return a, b, c
    end
end

local function cooldownReading(remaining)
    if not ns.Shared.Numbers.IsFinite(remaining) or remaining < 0 then
        return { status = "unavailable", state = "unknown" }
    end
    return {
        status = "available",
        state = remaining == 0 and "no_active_cooldown" or "cooldown",
        remainingSeconds = remaining,
    }
end

local function itemCooldown(id)
    local get = C_Container and C_Container.GetItemCooldown
    local expectsBoolean = type(get) ~= "function"
    if expectsBoolean then
        get = C_Item and C_Item.GetItemCooldown
    end
    local start, duration, enabled = readPublic(get, id)
    local now = readPublic(GetTime)
    local isFinite = ns.Shared.Numbers.IsFinite
    -- The container API reports 1 for enabled; the item API reports true.
    if
        enabled ~= (expectsBoolean and true or 1)
        or not (isFinite(start) and isFinite(duration) and isFinite(now))
        or start < 0
        or duration < 0
        or start > now
    then
        return cooldownReading()
    end
    return cooldownReading(math.max(0, duration - (now - start)))
end

local function spellCooldown(id)
    -- Ignore the global cooldown so it cannot appear as the spell's own timer.
    local duration = readPublic(C_Spell.GetSpellCooldownDuration, id, true)
    if
        (type(duration) == "userdata" or type(duration) == "table")
        and readPublic(duration.HasSecretValues, duration) == false
    then
        return cooldownReading(readPublic(duration.GetRemainingDuration, duration))
    end
    return cooldownReading()
end

function inspectors.reference(args)
    if args.kind == "item" then
        if args.includeCooldown ~= true then
            return itemDetails(args.id)
        end
        local ok, details = pcall(itemDetails, args.id)
        if not ok then
            details = { id = args.id, status = "unavailable" }
        end
        details.cooldown = itemCooldown(args.id)
        return details
    end
    if args.kind == "spell" or args.kind == "talent" then
        assert(C_Spell and C_Spell.GetSpellInfo, "Spell API is unavailable")
        local info = C_Spell.GetSpellInfo(args.id)
        assert(info, "Spell data is not available for this ID")
        local details = {
            id = args.id,
            info = info,
            description = C_Spell.GetSpellDescription and C_Spell.GetSpellDescription(args.id),
            tooltip = tooltip("spell:" .. args.id),
        }
        if args.kind == "spell" and args.includeCooldown == true then
            details.cooldown = spellCooldown(args.id)
        end
        return details
    end
    assert(C_QuestLog, "Quest API is unavailable")
    local title = C_QuestLog.GetTitleForQuestID and C_QuestLog.GetTitleForQuestID(args.id)
    if not title and C_QuestLog.RequestLoadQuestByID then
        C_QuestLog.RequestLoadQuestByID(args.id)
    end
    local index = C_QuestLog.GetLogIndexForQuestID and C_QuestLog.GetLogIndexForQuestID(args.id)
    return {
        id = args.id,
        title = title,
        status = title and "available" or "loading",
        inLog = index and index > 0 or false,
        rewardXP = index and index > 0 and ns.Character.QuestRewardXP(args.id) or nil,
        logInfo = index and index > 0 and C_QuestLog.GetInfo(index) or nil,
        objectives = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(args.id),
        completed = C_QuestLog.IsQuestFlaggedCompleted
            and C_QuestLog.IsQuestFlaggedCompleted(args.id),
        tooltip = tooltip("quest:" .. args.id),
    }
end
function inspectors.target()
    assert(UnitExists("target"), "No target selected")
    local guid = UnitGUID("target")
    local kind, _, _, _, _, npcID = strsplit("-", guid or "")
    return {
        name = UnitName("target"),
        level = UnitLevel("target"),
        classification = UnitClassification("target"),
        npcId = (kind == "Creature" or kind == "Vehicle") and tonumber(npcID) or nil,
        isPlayer = UnitIsPlayer("target"),
        faction = UnitFactionGroup("target"),
        reaction = UnitReaction("player", "target"),
        attackable = UnitCanAttack("player", "target"),
        dead = UnitIsDead("target"),
        note = "Target coordinates and fight difficulty were not inferred.",
    }
end

function inspectors.hearthstone()
    local name = readPublic(GetBindLocation)
    if type(name) == "string" and name:find("%S") then
        return {
            bind = { status = "available", name = ns.Shared.Text.TruncateUtf8Bytes(name, 180) },
        }
    end
    return { bind = { status = "unavailable" } }
end

local trainerOpen, auctionOpen = false, false
local inspectionEvents = CreateFrame("Frame")
for _, event in ipairs({
    "TRAINER_SHOW",
    "TRAINER_CLOSED",
    "AUCTION_HOUSE_SHOW",
    "AUCTION_HOUSE_CLOSED",
}) do
    inspectionEvents:RegisterEvent(event)
end
inspectionEvents:SetScript("OnEvent", function(_, event)
    if event == "TRAINER_SHOW" then
        trainerOpen = true
    elseif event == "TRAINER_CLOSED" then
        trainerOpen = false
    elseif event == "AUCTION_HOUSE_SHOW" then
        auctionOpen = true
    elseif event == "AUCTION_HOUSE_CLOSED" then
        auctionOpen = false
    end
end)
function inspectors.training(args)
    return ns.Character.QueryTraining(args)
end
function inspectors.trainer()
    assert(
        trainerOpen or (ClassTrainerFrame and ClassTrainerFrame:IsShown()),
        "Talk to a trainer and keep the trainer window open first"
    )
    assert(GetNumTrainerServices and GetTrainerServiceInfo, "Trainer services API is unavailable")
    local services = {}
    for index = 1, math.min(GetNumTrainerServices(), 300) do
        local name, status, _, requiredLevel, rank, category = GetTrainerServiceInfo(index)
        if name then
            services[#services + 1] = {
                name = name,
                status = status,
                requiredLevel = requiredLevel,
                rank = rank,
                category = category,
                costCopper = GetTrainerServiceCost and GetTrainerServiceCost(index),
            }
        end
    end
    return {
        trainer = UnitName("npc"),
        moneyCopper = GetMoney(),
        services = services,
        note = "Only services exposed by current trainer filters were read. No training was performed.",
    }
end
function inspectors.progression(args)
    local quests, reputations = {}, {}
    for _, id in ipairs(args.questIds or {}) do
        local ok, completed = pcall(C_QuestLog.IsQuestFlaggedCompleted, id)
        quests[#quests + 1] = {
            id = id,
            status = ok and type(completed) == "boolean" and "available" or "unavailable",
            completed = ok and completed or nil,
        }
        if ok and completed == false then
            quests[#quests].completed = false
        end
    end
    for _, id in ipairs(args.factionIds or {}) do
        local ok, data = pcall(function()
            return C_Reputation.GetFactionDataByID(id)
        end)
        reputations[#reputations + 1] = {
            id = id,
            status = ok and data and "available" or "unavailable",
            data = ok and data or nil,
        }
    end
    return {
        active = ns.Character.ReadQuests(),
        completion = quests,
        reputations = reputations,
        note = "Completion flags do not establish current quest availability or chain prerequisites.",
    }
end
function inspectors.resources()
    local bags = ns.Character.ReadBags()
    local free, capacity, freeKnown = 0, 0, true
    for bag = 0, NUM_BAG_SLOTS do
        capacity = capacity + C_Container.GetContainerNumSlots(bag)
        local count = C_Container.GetContainerNumFreeSlots
            and C_Container.GetContainerNumFreeSlots(bag)
        if type(count) == "number" then
            free = free + count
        else
            freeKnown = false
        end
    end
    local skills, collapsed = {}, false
    if C_SkillInfo and C_SkillInfo.GetNumSkillLines and C_SkillInfo.GetSkillLineInfo then
        for index = 1, C_SkillInfo.GetNumSkillLines() do
            local info = C_SkillInfo.GetSkillLineInfo(index)
            if info then
                if info.isHeader then
                    if info.isCollapsed then
                        collapsed = true
                    end
                else
                    skills[#skills + 1] = {
                        id = info.skillID,
                        name = info.name,
                        rank = info.rank,
                        maxRank = info.maxRank,
                        category = info.skillLineCategoryID,
                    }
                end
            end
        end
    end
    return {
        moneyCopper = GetMoney(),
        bags = bags.items,
        freeBagSlots = freeKnown and free or nil,
        bagCapacity = capacity,
        skills = skills,
        skillsStatus = C_SkillInfo
                and C_SkillInfo.GetNumSkillLines
                and C_SkillInfo.GetSkillLineInfo
                and "available"
            or "unavailable",
        collapsedSkills = collapsed,
    }
end
local equipmentSlots = {
    INVTYPE_HEAD = { 1 },
    INVTYPE_NECK = { 2 },
    INVTYPE_SHOULDER = { 3 },
    INVTYPE_BODY = { 4 },
    INVTYPE_CHEST = { 5 },
    INVTYPE_ROBE = { 5 },
    INVTYPE_WAIST = { 6 },
    INVTYPE_LEGS = { 7 },
    INVTYPE_FEET = { 8 },
    INVTYPE_WRIST = { 9 },
    INVTYPE_HAND = { 10 },
    INVTYPE_FINGER = { 11, 12 },
    INVTYPE_TRINKET = { 13, 14 },
    INVTYPE_CLOAK = { 15 },
    INVTYPE_WEAPON = { 16, 17 },
    INVTYPE_2HWEAPON = { 16 },
    INVTYPE_WEAPONMAINHAND = { 16 },
    INVTYPE_WEAPONOFFHAND = { 17 },
    INVTYPE_SHIELD = { 17 },
    INVTYPE_HOLDABLE = { 17 },
    INVTYPE_RANGED = { 18 },
    INVTYPE_RANGEDRIGHT = { 18 },
    INVTYPE_THROWN = { 18 },
    INVTYPE_RELIC = { 18 },
    INVTYPE_TABARD = { 19 },
}
local function statDelta(candidate, equipped)
    if not candidate or not equipped then
        return nil
    end
    local delta = {}
    for key, value in pairs(candidate) do
        delta[key] = value - (equipped[key] or 0)
    end
    for key, value in pairs(equipped) do
        if not candidate[key] then
            delta[key] = -value
        end
    end
    return delta
end
function inspectors.compare_items(args)
    local candidates = {}
    for _, id in ipairs(args.itemIds) do
        local item = itemDetails(id)
        local comparisons = {}
        for _, slot in
            ipairs(args.slot and { args.slot } or equipmentSlots[item.equipLocation] or {})
        do
            local equippedID = GetInventoryItemID("player", slot)
            local equipped = equippedID and itemDetails(equippedID)
            local delta = item.stats and equipped and statDelta(item.stats, equipped.stats)
            comparisons[#comparisons + 1] =
                { slot = slot, equipped = equipped, empty = not equippedID, statDelta = delta }
        end
        candidates[#candidates + 1] = { item = item, comparisons = comparisons }
    end
    return {
        candidates = candidates,
        note = "Raw per-slot stat differences only. No DPS simulation, weights, set/proc valuation or combined two-hand/off-hand replacement calculation.",
    }
end

-- Reads many candidate IDs at once (for example a category listing) and keeps
-- the wearable-by-level ones, each compared with its weakest matching slot.
local function itemSummary(id)
    local name, link, quality, itemLevel, requiredLevel, _, _, _, equipLocation =
        C_Item.GetItemInfo(id)
    if not name then
        if C_Item.RequestLoadItemDataByID then
            C_Item.RequestLoadItemDataByID(id)
        end
        return nil
    end
    return {
        id = id,
        name = name,
        link = link,
        quality = quality,
        itemLevel = itemLevel,
        requiredLevel = requiredLevel,
        equipLocation = equipLocation,
        stats = C_Item.GetItemStats and C_Item.GetItemStats(link) or nil,
    }
end
-- An occupied slot whose item is not cached yet is unknown, not empty: the
-- comparison waits for it instead of treating it as item level zero.
local function weakestSlot(slots)
    local best, uncached
    for _, slot in ipairs(slots) do
        local equippedID = GetInventoryItemID("player", slot)
        local equipped = equippedID and itemSummary(equippedID)
        if equippedID and not equipped then
            uncached = uncached or equippedID
        else
            local level = equipped and equipped.itemLevel or 0
            if not best or not equippedID or level < best.level then
                best = { slot = slot, equipped = equipped, empty = not equippedID, level = level }
                if not equippedID then
                    break
                end
            end
        end
    end
    if uncached and not (best and best.empty) then
        return nil, uncached
    end
    return best
end
-- Bridge-only: the bridge lists catalog IDs for gear searches and the agent
-- chooses among every match, so nothing is cut here.
function inspectors.gear_candidates(args)
    assert(C_Item and C_Item.GetItemInfo, "Item API is unavailable")
    local maxLevel = args.maxRequiredLevel or UnitLevel("player")
    local minLevel = args.minRequiredLevel or 0
    local ranked, loadingIds, equippedLoading = {}, {}, {}
    local counts =
        { requested = #args.itemIds, tooHighLevel = 0, tooLowLevel = 0, notEquipment = 0 }
    for _, id in ipairs(args.itemIds) do
        local item = itemSummary(id)
        local slots = item and equipmentSlots[item.equipLocation]
        if not item then
            loadingIds[#loadingIds + 1] = id
        elseif not slots then
            counts.notEquipment = counts.notEquipment + 1
        elseif (item.requiredLevel or 0) > maxLevel then
            counts.tooHighLevel = counts.tooHighLevel + 1
        elseif (item.requiredLevel or 0) < minLevel then
            counts.tooLowLevel = counts.tooLowLevel + 1
        else
            local target, uncachedID = weakestSlot(slots)
            item.link = nil
            if target then
                local equipped = target.equipped
                item.slot = target.slot
                item.emptySlot = target.empty
                item.equipped = equipped
                    and { id = equipped.id, name = equipped.name, itemLevel = equipped.itemLevel }
                item.itemLevelGain = (item.itemLevel or 0) - target.level
                -- Only a genuinely empty slot compares against no stats; unread
                -- equipped stats leave the difference unknown, not inflated.
                local baseline = target.empty and {} or (equipped and equipped.stats)
                item.statDelta = item.stats and baseline and statDelta(item.stats, baseline) or nil
            else
                item.equipped = { id = uncachedID, status = "loading" }
                equippedLoading[uncachedID] = true
            end
            ranked[#ranked + 1] = item
        end
    end
    table.sort(ranked, function(a, b)
        local gainA, gainB = a.itemLevelGain or -math.huge, b.itemLevelGain or -math.huge
        if gainA ~= gainB then
            return gainA > gainB
        end
        return a.id < b.id
    end)
    counts.matching = #ranked
    for id in pairs(equippedLoading) do
        loadingIds[#loadingIds + 1] = id
    end
    table.sort(loadingIds)
    return {
        status = #loadingIds > 0 and "loading" or "available",
        items = ranked,
        counts = counts,
        loadingIds = #loadingIds > 0 and loadingIds or nil,
        note = "Every match, ordered by item level gain over the weakest matching equipped slot; the order is not a recommendation or stat weighting. Armor/weapon proficiency is not checked. loadingIds were not in the client cache yet.",
    }
end
function inspectors.auctions(args)
    assert(
        auctionOpen
            or (AuctionHouseFrame and AuctionHouseFrame:IsShown())
            or (AuctionFrame and AuctionFrame:IsShown()),
        "Open the auction house and load a search first"
    )
    local results, limit = {}, args.limit or 20
    local source, loaded, total
    if GetNumAuctionItems and GetAuctionItemInfo then
        source = "legacy loaded search results"
        loaded, total = GetNumAuctionItems("list")
        for index = 1, math.min(loaded, 5000) do
            local values = { GetAuctionItemInfo("list", index) }
            if not args.itemId or values[17] == args.itemId then
                local quantity, buyout = values[3], values[10]
                results[#results + 1] = {
                    itemId = values[17],
                    name = values[1],
                    quantity = quantity,
                    buyoutCopper = buyout,
                    unitBuyoutCopper = quantity
                            and quantity > 0
                            and buyout
                            and buyout > 0
                            and buyout / quantity
                        or nil,
                    bidCopper = values[11],
                    minimumBidCopper = values[8],
                }
                if #results >= limit then
                    break
                end
            end
        end
    elseif C_AuctionHouse and C_AuctionHouse.GetBrowseResults then
        source = "modern loaded browse results"
        local browse = C_AuctionHouse.GetBrowseResults() or {}
        loaded = #browse
        for _, result in ipairs(browse) do
            local id = result.itemKey and result.itemKey.itemID
            if not args.itemId or id == args.itemId then
                results[#results + 1] = {
                    itemId = id,
                    itemKey = result.itemKey,
                    minimumPriceCopper = result.minPrice,
                    totalQuantity = result.totalQuantity,
                }
                if #results >= limit then
                    break
                end
            end
        end
    else
        error("Auction results API is unavailable")
    end
    return {
        realm = GetRealmName(),
        faction = UnitFactionGroup("player"),
        source = source,
        loadedResults = loaded,
        totalSearchResults = total,
        results = results,
        partial = true,
        pricesAsOf = "unknown; results were already cached by the game",
        note = "No search, scan or purchase was performed. Empty/filtered results do not imply no auctions exist. Prices are copper; stack and unit prices are separate.",
    }
end
local function macroLimits()
    local limits = Constants and Constants.MacroConsts
    return (limits and limits.MAX_ACCOUNT_MACROS) or MAX_ACCOUNT_MACROS,
        (limits and limits.MAX_CHARACTER_MACROS) or MAX_CHARACTER_MACROS
end
function inspectors.macros(args)
    assert(GetNumMacros and GetMacroInfo, "Macro API is unavailable")
    local account, character = GetNumMacros()
    local accountLimit, characterLimit = macroLimits()
    assert(accountLimit and characterLimit, "Macro slot limits could not be read")
    local names = {}
    for _, name in ipairs(args.names or {}) do
        names[name] = true
    end
    local macros = {}
    local function read(index, scope)
        local name, _, body = GetMacroInfo(index)
        if name and (not next(names) or names[name]) then
            macros[#macros + 1] =
                { name = name, scope = scope, body = args.includeBodies and body or nil }
        end
    end
    for index = 1, account do
        read(index, "account")
    end
    for index = 1, character do
        read(accountLimit + index, "character")
    end
    return {
        macros = macros,
        accountCount = account,
        characterCount = character,
        accountLimit = accountLimit,
        characterLimit = characterLimit,
    }
end
inspectors.chat = function(args)
    return ns.ChatHistory.ReadChatHistory(args)
end
inspectors.dungeons = function(args)
    return ns.Character.ReadDungeons(args)
end
inspectors.combat = function(args)
    return ns.Combat.Read(args)
end
function ns.Character.Inspect(inspection)
    if inspection and ns.Integrations.InspectIntegration then
        local result = ns.Integrations.InspectIntegration(inspection)
        if result then
            return result
        end
    end
    if inspection and inspection.kind == "npc_locations" then
        local ok, data = pcall(ns.Integrations.FindNPCLocations, inspection.args or {})
        return {
            status = ok and "available" or "unavailable",
            data = ok and data or nil,
            error = not ok and tostring(data) or nil,
            capturedAt = time(),
            source = "QuestieDB Forever",
        }
    end
    if inspection and inspection.kind == "settings" then
        local ok, data = pcall(ns.Settings.ReadSettings, inspection.args or {})
        return {
            status = ok and "available" or "unavailable",
            data = ok and data or nil,
            error = not ok and tostring(data) or nil,
            capturedAt = time(),
        }
    end
    local read = inspection and inspectors[inspection.kind]
    if not read then
        return { status = "unavailable", error = "Unknown inspection" }
    end
    local ok, data = pcall(read, inspection.args or {})
    return {
        capturedAt = time(),
        character = UnitName("player"),
        source = inspection.kind == "flight_paths" and "WoW flight maps"
            or (inspection.kind == "dungeons" and "WoW group finder and Wisp dungeon entrance table")
            or (inspection.kind == "training" and "Bundled What's Training? Forever catalog")
            or "WoW addon live API",
        status = ok and "available" or "unavailable",
        data = ok and data or nil,
        error = not ok and tostring(data) or nil,
    }
end

local function readWaypoint()
    local point = C_Map.GetUserWaypoint()
    if not point then
        return nil
    end
    local position = point.position
    assert(
        type(position) == "table" or type(position) == "userdata",
        "The game returned invalid waypoint coordinates"
    )
    local x, y
    if type(position.GetXY) == "function" then
        x, y = position:GetXY()
    else
        x, y = position.x, position.y
    end
    assert(
        type(x) == "number" and type(y) == "number" and x >= 0 and x <= 1 and y >= 0 and y <= 1,
        "The game returned invalid waypoint coordinates"
    )
    return { mapId = point.uiMapID, x = x * 100, y = y * 100 }
end
function inspectors.map(args)
    assert(C_Map and C_Map.GetMapInfo, "Map API is unavailable")
    local current = C_Map.GetBestMapForUnit("player")
    local maps, seen, root = {}, {}, current
    local function add(id)
        if seen[id] then
            return nil
        end
        seen[id] = true
        local info = C_Map.GetMapInfo(id)
        if info then
            maps[#maps + 1] = info
        end
        return info
    end
    local id = current
    for _ = 1, 12 do
        if not id or id == 0 then
            break
        end
        local info = add(id)
        if not info then
            break
        end
        root = id
        id = info.parentMapID
    end
    for _, requested in ipairs(args.mapIds or {}) do
        add(requested)
    end
    local matches, truncated, searchStatus = {}, false, "not_requested"
    if args.query and root and C_Map.GetMapChildrenInfo then
        searchStatus = "available"
        local query = args.query:lower()
        local children = C_Map.GetMapChildrenInfo(root, nil, true) or {}
        truncated = #children > 2000
        for index = 1, math.min(#children, 2000) do
            local info = children[index]
            if info.name and info.name:lower():find(query, 1, true) then
                matches[#matches + 1] = info
            end
            if #matches >= 30 then
                truncated = true
                break
            end
        end
    elseif args.query then
        searchStatus = "unavailable"
    end
    return {
        currentMapId = current,
        maps = maps,
        matches = matches,
        searchStatus = searchStatus,
        truncated = truncated,
        waypoint = C_Map.GetUserWaypoint and readWaypoint() or nil,
        waypointStatus = C_Map.GetUserWaypoint and "available" or "unavailable",
        note = "Localized map metadata only, not NPC positions. Search covers the current world hierarchy, not necessarily every map.",
    }
end

function inspectors.flight_paths(args)
    return ns.Character.ReadFlightPaths(args)
end

ns.Character._ReadWaypoint = readWaypoint
ns.Character._MacroLimits = macroLimits
