local _, ns = ...
local finite = ns.Shared.Numbers.IsFinite
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
    if ok and finite(xp) and xp >= 0 then
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
ns.Character.ReadQuests = collectors.quests
ns.Character.ReadBags = collectors.bags
ns.Character.QuestRewardXP = questRewardXP
function ns.Character.Capture(sections)
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
function ns.Character.CaptureTurn()
    local snapshot = ns.Character.Capture({ "character", "location" })
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
        if (ns.characterAcknowledged or 0) >= characterRevision then
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
    if (ns.questAcknowledged or 0) < questRevision then
        snapshot.sections.quests = { status = "available", data = compact }
    end
    return snapshot
end
local questEvents, questSyncPending, questSyncSent = CreateFrame("Frame"), false, nil
questEvents:RegisterEvent("QUEST_LOG_UPDATE")
questEvents:SetScript("OnEvent", function()
    if questSyncPending or not ns.connected then
        return
    end
    questSyncPending = true
    C_Timer.After(0.5, function()
        questSyncPending = false
        local snapshot = ns.Character.CaptureTurn()
        if snapshot.sections.quests and snapshot.questRevision ~= questSyncSent then
            questSyncSent = snapshot.questRevision
            ns.Transport.Send({ type = "quest_sync", context = snapshot })
        end
    end)
end)
