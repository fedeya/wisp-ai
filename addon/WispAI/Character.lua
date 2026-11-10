local _, C = ...
local collectors = {}
function collectors.character()
    local _, class = UnitClass("player")
    local version, build = GetBuildInfo()
    return {
        name = UnitName("player"),
        realm = GetRealmName(),
        level = UnitLevel("player"),
        class = class,
        race = UnitRace("player"),
        raceToken = select(2, UnitRace("player")),
        faction = UnitFactionGroup("player"),
        moneyCopper = GetMoney(),
        xp = UnitXP("player"),
        xpMax = UnitXPMax("player"),
        game = "WoW Forever",
        version = version,
        build = build,
    }
end
function collectors.location()
    local id = C_Map.GetBestMapForUnit("player")
    local pos = id and C_Map.GetPlayerMapPosition(id, "player")
    local x, y
    if pos then
        x, y = pos:GetXY()
    end
    return { zone = GetZoneText(), subzone = GetSubZoneText(), mapId = id, x = x, y = y }
end
function collectors.spells()
    local out = {}
    assert(C_SpellBook and C_SpellBook.GetNumSpellBookSkillLines, "Spellbook API is unavailable")
    for line = 1, C_SpellBook.GetNumSpellBookSkillLines() do
        local info = C_SpellBook.GetSpellBookSkillLineInfo(line)
        if info and not info.shouldHide then
            for slot = info.itemIndexOffset + 1, info.itemIndexOffset + info.numSpellBookItems do
                local item = C_SpellBook.GetSpellBookItemInfo(slot, Enum.SpellBookSpellBank.Player)
                if
                    item
                    and item.spellID
                    and item.itemType == Enum.SpellBookItemType.Spell
                    and not item.isOffSpec
                then
                    table.insert(out, {
                        id = item.spellID,
                        name = item.name or C_Spell.GetSpellName(item.spellID),
                        rank = item.subName,
                    })
                end
            end
        end
    end
    return { known = out, count = #out }
end
function collectors.talents()
    assert(C_SpecializationInfo and C_Traits, "Talent API is unavailable")
    local configID = C_SpecializationInfo.GetCombatConfigIDForSpecGroup(
        C_SpecializationInfo.GetActiveSpecGroup()
    )
    assert(configID, "Active talent configuration could not be identified")
    local config = C_Traits.GetConfigInfo(configID)
    assert(config and config.treeIDs, "Talent tree could not be read")
    local selected, currencies, pools = {}, {}, {}
    local currencyError, hasPendingChanges
    if C_Traits.ConfigHasStagedChanges then
        local ok, value = pcall(C_Traits.ConfigHasStagedChanges, configID)
        if ok and type(value) == "boolean" then
            hasPendingChanges = value
        end
    end
    local function pointCount(value)
        return type(value) == "number" and value >= 0 and value == math.floor(value)
    end
    for _, tree in ipairs(config.treeIDs) do
        local groups = {}
        if C_Traits.GetGroupDisplayInfoByTreeID then
            local ok, values = pcall(C_Traits.GetGroupDisplayInfoByTreeID, tree)
            if ok and type(values) == "table" then
                for _, group in ipairs(values) do
                    groups[group.groupID] = group.displayName
                end
            end
        end
        for _, nodeID in ipairs(C_Traits.GetTreeNodes(tree) or {}) do
            local node = C_Traits.GetNodeInfo(configID, nodeID)
            if
                node
                and type(node.activeRank) == "number"
                and node.activeRank > 0
                and node.activeEntry
            then
                local entry = C_Traits.GetEntryInfo(configID, node.activeEntry.entryID)
                local definition = entry
                    and entry.definitionID
                    and C_Traits.GetDefinitionInfo(entry.definitionID)
                local branch
                for _, groupID in ipairs(node.groupIDs or {}) do
                    if groups[groupID] then
                        branch = groups[groupID]
                        break
                    end
                end
                if definition and definition.spellID then
                    table.insert(selected, {
                        id = definition.spellID,
                        name = C_Spell.GetSpellName(definition.spellID),
                        rank = node.activeRank,
                        maxRank = node.maxRanks,
                        nodeId = nodeID,
                        branch = branch,
                    })
                end
            end
        end
        if C_Traits.GetTreeCurrencyInfo then
            -- Camelot's ClassTalentsFrame uses the first tree currency for its talent-point display.
            -- Exclude staged changes so the primary count describes the applied configuration.
            local ok, values = pcall(C_Traits.GetTreeCurrencyInfo, configID, tree, true)
            local currency = ok and type(values) == "table" and values[1]
            if currency and currency.traitCurrencyID and pointCount(currency.quantity) then
                local old = pools[currency.traitCurrencyID]
                if
                    old
                    and (
                        old.available ~= currency.quantity
                        or old.spent ~= currency.spent
                        or old.total ~= currency.maxQuantity
                    )
                then
                    currencyError = "Shared talent currency returned inconsistent counts"
                elseif not old then
                    local pool = {
                        id = currency.traitCurrencyID,
                        available = currency.quantity,
                        spent = pointCount(currency.spent) and currency.spent or nil,
                        total = pointCount(currency.maxQuantity) and currency.maxQuantity or nil,
                    }
                    pools[pool.id] = pool
                    table.insert(currencies, pool)
                    if hasPendingChanges then
                        local previewOK, preview =
                            pcall(C_Traits.GetTreeCurrencyInfo, configID, tree, false)
                        if previewOK and type(preview) == "table" then
                            for _, staged in ipairs(preview) do
                                if
                                    staged.traitCurrencyID == pool.id
                                    and pointCount(staged.quantity)
                                then
                                    pool.previewAvailable = staged.quantity
                                end
                            end
                        end
                    end
                end
            else
                currencyError = "Talent currencies could not be read"
            end
        else
            currencyError = "Available-points API is unavailable"
        end
    end
    local pool = not currencyError and #currencies == 1 and currencies[1] or nil
    return {
        configId = configID,
        selected = selected,
        currencies = currencies,
        unspentPoints = pool and pool.available,
        spentPoints = pool and pool.spent,
        totalPoints = pool and pool.total,
        unspentStatus = pool and "known" or "unknown",
        hasPendingChanges = hasPendingChanges,
        previewUnspentPoints = pool and pool.previewAvailable,
        note = currencyError
            or (
                not pool
                    and "No single talent-point pool could be identified; use the separate currencies, never infer from level."
                or (
                    hasPendingChanges
                        and "Primary points exclude pending changes. Selected nodes may reflect the talent-window preview; changes must be applied before treating them as learned."
                    or "Points were read from the active talent configuration, excluding staged changes."
                )
            ),
    }
end
local function questRewardXP(id)
    if not GetQuestLogRewardXP then
        return nil
    end
    local ok, xp = pcall(GetQuestLogRewardXP, id)
    if ok and type(xp) == "number" and xp >= 0 and xp < math.huge then
        return xp
    end
end

function collectors.quests()
    local out = {}
    for index = 1, C_QuestLog.GetNumQuestLogEntries() do
        local info = C_QuestLog.GetInfo(index)
        if info and not info.isHeader and not info.isHidden then
            table.insert(out, {
                id = info.questID,
                title = info.title,
                level = info.level,
                rewardXP = questRewardXP(info.questID),
                complete = C_QuestLog.IsComplete(info.questID),
                objectives = C_QuestLog.GetQuestObjectives(info.questID) or {},
            })
        end
    end
    return { quests = out, count = #out }
end
function collectors.gear()
    local out = {}
    for slot = 1, 19 do
        local id = GetInventoryItemID("player", slot)
        if id then
            table.insert(out, { slot = slot, id = id, link = GetInventoryItemLink("player", slot) })
        end
    end
    return { items = out }
end
function collectors.bags()
    local out = {}
    for bag = 0, NUM_BAG_SLOTS do
        for slot = 1, C_Container.GetContainerNumSlots(bag) do
            local item = C_Container.GetContainerItemInfo(bag, slot)
            if item then
                table.insert(out, {
                    bag = bag,
                    slot = slot,
                    id = item.itemID,
                    count = item.stackCount,
                    link = item.hyperlink,
                })
            end
        end
    end
    return { items = out }
end
function C.Capture(sections)
    local out = {
        capturedAt = time(),
        source = "WoW addon live API",
        character = UnitName("player"),
        sections = {},
    }
    for _, section in ipairs(sections or {}) do
        local collector = collectors[section]
        if collector then
            local ok, data = pcall(collector)
            if ok then
                out.sections[section] = { status = "available", data = data }
            else
                out.sections[section] = { status = "unavailable", error = tostring(data) }
            end
        else
            out.sections[section] = { status = "unavailable", error = "Unknown section" }
        end
    end
    return out
end

-- Revalidate at send time; acknowledged revisions avoid retransmitting an
-- unchanged log. Quest events warm the bridge cache outside the user's turn.
local questSignature, questRevision = nil, 0
local characterSignature, characterRevision = nil, 0
function C.CaptureTurn()
    local snapshot = C.Capture({ "character", "location" })
    -- The bridge knows this source and resolves identity from the section.
    snapshot.source, snapshot.character = nil, nil
    local character = snapshot.sections.character
    if character and character.status == "available" then
        local data = {}
        for _, key in ipairs({
            "name",
            "realm",
            "level",
            "class",
            "race",
            "faction",
            "game",
            "version",
            "build",
        }) do
            data[key] = character.data[key]
        end
        local signature = C_EncodingUtil.SerializeJSON(data)
        if signature ~= characterSignature then
            characterSignature = signature
            characterRevision = characterRevision + 1
        end
        snapshot.characterRevision = characterRevision
        snapshot.sections.character = { status = "available", data = data }
        if (C.characterAcknowledged or 0) >= characterRevision then
            snapshot.sections.character = nil
        end
    end
    local ok, data = pcall(collectors.quests)
    if not ok then
        return snapshot -- Ordinary query tools remain the fallback.
    end
    local compact = { quests = {}, count = data.count, truncated = data.count > 40 }
    for index, quest in ipairs(data.quests) do
        if index > 40 then
            break
        end
        local objectives = {}
        for _, objective in ipairs(quest.objectives) do
            objectives[#objectives + 1] = {
                text = objective.text,
                finished = objective.finished,
                numFulfilled = objective.numFulfilled,
                numRequired = objective.numRequired,
            }
        end
        compact.quests[#compact.quests + 1] = {
            id = quest.id,
            title = quest.title,
            level = quest.level,
            rewardXP = quest.rewardXP,
            complete = quest.complete,
            objectives = objectives,
        }
    end
    local encoded, signature = pcall(C_EncodingUtil.SerializeJSON, compact)
    if not encoded then
        return snapshot
    end
    if signature ~= questSignature then
        questSignature = signature
        questRevision = questRevision + 1
    end
    snapshot.questRevision = questRevision
    if (C.questAcknowledged or 0) < questRevision then
        snapshot.sections.quests = { status = "available", data = compact }
    end
    return snapshot
end
local questEvents, questSyncPending, questSyncSent = CreateFrame("Frame"), false, nil
questEvents:RegisterEvent("QUEST_LOG_UPDATE")
questEvents:SetScript("OnEvent", function()
    if questSyncPending or not C.connected then
        return
    end
    questSyncPending = true
    C_Timer.After(0.5, function()
        questSyncPending = false
        local snapshot = C.CaptureTurn()
        if snapshot.sections.quests and snapshot.questRevision ~= questSyncSent then
            questSyncSent = snapshot.questRevision
            C.Send({ type = "quest_sync", context = snapshot })
        end
    end)
end)

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
    local name, link, quality, level, requiredLevel, class, subclass, stackSize, equipLocation, icon, vendorPrice =
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
function inspectors.reference(args)
    if args.kind == "item" then
        return itemDetails(args.id)
    end
    if args.kind == "spell" or args.kind == "talent" then
        assert(C_Spell and C_Spell.GetSpellInfo, "Spell API is unavailable")
        local info = C_Spell.GetSpellInfo(args.id)
        assert(info, "Spell data is not available for this ID")
        return {
            id = args.id,
            info = info,
            description = C_Spell.GetSpellDescription and C_Spell.GetSpellDescription(args.id),
            tooltip = tooltip("spell:" .. args.id),
        }
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
        rewardXP = index and index > 0 and questRewardXP(args.id) or nil,
        logInfo = index and index > 0 and C_QuestLog.GetInfo(index) or nil,
        objectives = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(args.id),
        completed = C_QuestLog.IsQuestFlaggedCompleted
            and C_QuestLog.IsQuestFlaggedCompleted(args.id),
        tooltip = tooltip("quest:" .. args.id),
    }
end
function inspectors.group(args)
    return C.ReadGroup(args)
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
    return C.QueryTraining(args)
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
        active = collectors.quests(),
        completion = quests,
        reputations = reputations,
        note = "Completion flags do not establish current quest availability or chain prerequisites.",
    }
end
function inspectors.resources()
    local bags = collectors.bags()
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
            local delta
            if item.stats and equipped and equipped.stats then
                delta = {}
                for key, value in pairs(item.stats) do
                    delta[key] = value - (equipped.stats[key] or 0)
                end
                for key, value in pairs(equipped.stats) do
                    if not item.stats[key] then
                        delta[key] = -value
                    end
                end
            end
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
        local name, icon, body = GetMacroInfo(index)
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
    return C.ReadChatHistory(args)
end
function C.Inspect(inspection)
    if inspection and C.InspectIntegration then
        local result = C.InspectIntegration(inspection)
        if result then
            return result
        end
    end
    if inspection and inspection.kind == "npc_locations" then
        local ok, data = pcall(C.FindNPCLocations, inspection.args or {})
        return {
            status = ok and "available" or "unavailable",
            data = ok and data or nil,
            error = not ok and tostring(data) or nil,
            capturedAt = time(),
            source = "QuestieDB Forever",
        }
    end
    if inspection and inspection.kind == "settings" then
        local ok, data = pcall(C.ReadSettings, inspection.args or {})
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
        character = inspection.kind ~= "group" and UnitName("player") or nil,
        source = inspection.kind == "training" and "Bundled What's Training? Forever catalog"
            or "WoW addon live API",
        status = ok and "available" or "unavailable",
        data = ok and data or nil,
        error = not ok and tostring(data) or nil,
    }
end

local actions = {}
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
local function sameWaypoint(a, b)
    return a
        and b
        and a.mapId == b.mapId
        and math.abs(a.x - b.x) < 0.001
        and math.abs(a.y - b.y) < 0.001
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
    for depth = 1, 12 do
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
function actions.set_waypoint(args)
    assert(
        C_Map and C_Map.GetUserWaypoint and C_Map.SetUserWaypoint and UiMapPoint,
        "Native waypoint API is unavailable"
    )
    assert(
        type(args.mapId) == "number"
            and type(args.x) == "number"
            and type(args.y) == "number"
            and args.x >= 0
            and args.x <= 100
            and args.y >= 0
            and args.y <= 100,
        "Use a valid map and coordinates from 0 to 100"
    )
    local info = C_Map.GetMapInfo(args.mapId)
    assert(
        info and C_Map.CanSetUserWaypointOnMap(args.mapId),
        "This map cannot accept a native user waypoint"
    )
    local previous, owned = readWaypoint(), C.db.wispWaypoint
    local original = previous
    if
        sameWaypoint(previous, owned)
        and owned.owner == UnitName("player")
        and owned.realm == GetRealmName()
    then
        original = owned.previous
    end
    local wasSet = C_Map.SetUserWaypoint(
        UiMapPoint.CreateFromCoordinates(args.mapId, args.x / 100, args.y / 100)
    )
    assert(
        wasSet ~= false and sameWaypoint(readWaypoint(), args),
        "The game did not confirm the requested waypoint"
    )
    C.db.wispWaypoint = {
        mapId = args.mapId,
        x = args.x,
        y = args.y,
        label = args.label,
        source = args.source,
        previous = original,
        owner = UnitName("player"),
        realm = GetRealmName(),
    }
    local navigation = false
    if args.navigate and C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then
        local ok = pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, true)
        if ok and C_SuperTrack.IsSuperTrackingUserWaypoint then
            local readOK, tracked = pcall(C_SuperTrack.IsSuperTrackingUserWaypoint)
            navigation = readOK and tracked == true
        end
    end
    return {
        applied = true,
        mapId = args.mapId,
        mapName = info.name,
        x = args.x,
        y = args.y,
        label = args.label,
        source = args.source,
        navigation = navigation,
        reference = {
            kind = "map",
            label = args.label,
            mapId = args.mapId,
            x = args.x,
            y = args.y,
            source = args.source,
        },
        note = "Placed the native map pin. The character was not moved. Navigation is reported separately.",
    }
end
function actions.clear_waypoint()
    assert(C_Map and C_Map.GetUserWaypoint, "Native waypoint API is unavailable")
    local owned = C.db.wispWaypoint
    assert(owned, "Wisp has no recorded map marker to remove")
    assert(
        owned.owner == UnitName("player") and owned.realm == GetRealmName(),
        "This character has no Wisp marker to remove"
    )
    assert(
        sameWaypoint(readWaypoint(), owned),
        "The current marker was changed by the player; it was left untouched"
    )
    if owned.previous then
        local old = owned.previous
        assert(
            C_Map.SetUserWaypoint(
                UiMapPoint.CreateFromCoordinates(old.mapId, old.x / 100, old.y / 100)
            ) ~= false,
            "The previous marker could not be restored"
        )
        assert(sameWaypoint(readWaypoint(), old), "The game did not confirm the restored marker")
    else
        assert(C_Map.ClearUserWaypoint, "Clearing map markers is unavailable")
        C_Map.ClearUserWaypoint()
        assert(not readWaypoint(), "The game did not confirm removal of the marker")
    end
    C.db.wispWaypoint = nil
    return { applied = true, restoredPrevious = owned.previous ~= nil }
end
local macroCommands = {
    cast = true,
    castsequence = true,
    castrandom = true,
    use = true,
    userandom = true,
    stopcasting = true,
    stopmacro = true,
    target = true,
    targetexact = true,
    targetenemy = true,
    targetfriend = true,
    cleartarget = true,
    focus = true,
    clearfocus = true,
    assist = true,
    petattack = true,
    petfollow = true,
    petpassive = true,
    petdefensive = true,
    petassist = true,
    startattack = true,
    stopattack = true,
    cancelaura = true,
    dismount = true,
    cancelform = true,
    equip = true,
    equipslot = true,
}
local function validateMacro(args)
    assert(
        type(args.name) == "string"
            and args.name:find("%S")
            and #args.name <= 16
            and not args.name:find("[%c|%[%]()]"),
        "Use a short plain macro name"
    )
    assert(type(args.body) == "string", "Macro text is required")
    local body = args.body:gsub("\r\n", "\n"):gsub("\r", "\n")
    assert(
        body:find("%S") and #body <= 255 and not body:find("[%z\1-\8\11\12\14-\31|]"),
        "Macro text must contain at most 255 UTF-8 bytes"
    )
    for line in (body .. "\n"):gmatch("([^\n]*)\n") do
        local text = line:match("^%s*(.-)%s*$")
        if text ~= "" then
            local directive = text:match("^#([%a]+)%s") or text:match("^#([%a]+)$")
            local command = text:match("^/([%a]+)%s") or text:match("^/([%a]+)$")
            assert(
                (directive and (directive:lower() == "showtooltip" or directive:lower() == "show"))
                    or (command and macroCommands[command:lower()]),
                "Only standard spell/item/targeting macro commands are supported; scripts, console, click and chat commands are not"
            )
        end
    end
    return body
end
function actions.create_macro(args)
    local body = validateMacro(args)
    assert(InCombatLockdown, "Combat state is unavailable; no macro was created")
    assert(
        not InCombatLockdown(),
        "Leave combat before creating a macro. No macro was queued or executed"
    )
    assert(
        CreateMacro and GetMacroIndexByName and GetMacroInfo,
        "Macro creation API is unavailable"
    )
    local index = GetMacroIndexByName(args.name)
    local created = false
    if index and index > 0 then
        local _, _, existing = GetMacroInfo(index)
        assert(
            existing == body,
            "A different macro with this name already exists. Choose another name; existing macros were left unchanged"
        )
    else
        local account, character = GetNumMacros()
        local accountLimit, characterLimit = macroLimits()
        local limit, count =
            args.perCharacter and characterLimit or accountLimit,
            args.perCharacter and character or account
        assert(limit and count < limit, "No free macro slots in the selected scope")
        index = CreateMacro(args.name, 134400, body, args.perCharacter)
        assert(
            type(index) == "number" and index > 0,
            "The game did not confirm creation of the macro"
        )
        created = true
    end
    local name, _, actualBody = GetMacroInfo(index)
    local verified = name == args.name and actualBody == body
    local accountLimit = macroLimits()
    local scope = accountLimit and (index <= accountLimit and "account" or "character") or "unknown"
    return {
        created = created,
        verified = verified,
        name = name or args.name,
        body = actualBody or body,
        scope = scope,
        reference = { kind = "macro", label = args.name, name = args.name },
        note = "Macro was not executed or placed on an action bar. Click its reference to pick it up yourself.",
    }
end
function C.PerformAction(action)
    local expected = action and action.expectedCharacter
    if not expected or expected.name ~= UnitName("player") or expected.realm ~= GetRealmName() then
        return {
            status = "blocked",
            error = "Character identity changed; request the action again for the current character",
        }
    end
    local apply = actions[action.kind]
    if action.kind == "update_settings" then
        apply = C.UpdateSettings
    end
    if action.kind == "undo_settings" then
        apply = function(args)
            return C.ApplySettings(args.transactionId, true)
        end
    end
    if not apply then
        return { status = "unavailable", error = "Unknown action" }
    end
    local ok, result = pcall(apply, action.args or {})
    return {
        capturedAt = time(),
        character = UnitName("player"),
        source = "WoW addon action API",
        status = ok and "completed" or "blocked",
        data = ok and result or nil,
        error = not ok and tostring(result) or nil,
    }
end
