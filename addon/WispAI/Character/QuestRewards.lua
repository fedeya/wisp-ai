local _, ns = ...

-- Forever 4cd0ab752a77164f654ccbca9d0c1fe8dafceebe: QuestInfo.lua and QuestFrame.lua.
-- Observe only the player's open reward panel; never retain offers or request item loads.
local generation, rewardEvent = 0, false
local events = CreateFrame("Frame")
for _, event in ipairs({
    "QUEST_COMPLETE",
    "QUEST_FINISHED",
    "QUEST_GREETING",
    "QUEST_DETAIL",
    "QUEST_PROGRESS",
    "QUEST_ITEM_UPDATE",
    "PLAYER_ENTERING_WORLD",
}) do
    events:RegisterEvent(event)
end
events:SetScript("OnEvent", function(_, event)
    generation = generation + 1
    if event ~= "QUEST_ITEM_UPDATE" then
        rewardEvent = event == "QUEST_COMPLETE"
    end
end)

local slots = {
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

local function public(value)
    return not (issecretvalue and issecretvalue(value))
end

local function text(value, limit)
    if not public(value) or type(value) ~= "string" then
        return nil
    end
    return ns.Shared.Text.TruncateUtf8Bytes(value, limit)
end

local function integer(value, minimum, maximum)
    return public(value)
        and type(value) == "number"
        and value == value
        and value >= minimum
        and value <= maximum
        and value % 1 == 0
end

-- Outcome tokens are bounded and never include host exception text or stack paths.
local function pack(...)
    return { n = select("#", ...), ... }
end

local function callOutcome(fn, ...)
    if type(fn) ~= "function" then
        return "api_missing"
    end
    local result = pack(pcall(fn, ...))
    if result[1] then
        return nil, unpack(result, 2, result.n)
    end
    return "read_failed"
end

local function call(fn, ...)
    return select(2, callOutcome(fn, ...))
end

local function visible()
    local shown = QuestFrameRewardPanel
        and call(QuestFrameRewardPanel.IsVisible, QuestFrameRewardPanel)
    return rewardEvent and public(shown) and shown == true
end

local function exactItem(link, budget)
    local item = {
        link = link,
        status = "unknown",
        statsStatus = "unknown",
        capturedAt = time(),
        source = "Forever cached exact-link item API",
    }
    -- Preserve this single response's arity, including nil holes and all 18 documented fields.
    local info = pack(callOutcome(C_Item and C_Item.GetItemInfo, link))
    local reason, name, location = info[1], info[2], info[10]
    if reason then
        item.reason = reason
        return item
    end
    if not public(name) then
        item.reason = "restricted"
        return item
    end
    if name == nil then
        -- MayReturnNothing is a cache miss, not an inconsistent partially populated tuple.
        local populated = false
        for index = 3, info.n do
            if not public(info[index]) then
                item.reason = "restricted"
                return item
            elseif info[index] ~= nil then
                populated = true
            end
        end
        if populated then
            item.reason = "invalid_response"
            return item
        end
        item.status, item.reason = "loading", "uncached"
        return item
    end
    if type(name) ~= "string" or name == "" then
        item.reason = "invalid_response"
        return item
    end
    item.status = "available"
    item.name, item.nameTruncated = text(name, 160)
    item.equipLocation, item.equipLocationTruncated = text(location, 40)
    local statsReason, raw = callOutcome(C_Item and C_Item.GetItemStats, link)
    if statsReason then
        item.statsReason = statsReason
    elseif not public(raw) then
        item.statsReason = "restricted"
    elseif raw == nil then
        item.statsReason = "unavailable"
    elseif type(raw) ~= "table" then
        item.statsReason = "invalid_response"
    else
        local stats, count, valid = {}, 0, true
        for key, value in pairs(raw) do
            count = count + 1
            if not public(key) or not public(value) then
                item.statsReason = "restricted"
                valid = false
                break
            end
            if
                type(key) ~= "string"
                or #key > 80
                or not ns.Shared.Numbers.IsFinite(value)
                or math.abs(value) > 1000000000
            then
                item.statsReason = "invalid_response"
                valid = false
                break
            end
            if count > 32 or budget.stats <= 0 then
                item.statsTruncated = true
                item.statsReason = count > 32 and "item_stat_limit" or "observation_stat_limit"
                valid = false
                break
            end
            budget.stats = budget.stats - 1
            stats[key] = value
        end
        if valid then
            item.stats, item.statsStatus = stats, "available"
        end
    end
    item.truncated = item.nameTruncated == true
        or item.equipLocationTruncated == true
        or item.statsTruncated == true
    return item
end

local function option(kind, index, budget)
    local item = { index = index, kind = "unknown", status = "unknown", capturedAt = time() }
    local loot
    if kind == "choice" then
        loot = call(GetQuestItemInfoLootType, kind, index)
    else
        loot = 0
    end
    if not public(loot) then
        return item
    end
    if loot ~= 0 then
        item.kind = loot == 1 and "currency" or "unknown"
        item.status = loot == nil and "unknown" or "unsupported"
        return item
    end
    item.kind = "item"
    local name, _, quantity, _, _, id = call(GetQuestItemInfo, kind, index)
    item.name, item.nameTruncated = text(name, 160)
    item.truncated = item.nameTruncated == true
    item.quantity = integer(quantity, 0, 1000000) and quantity or nil
    item.id = integer(id, 1, 2147483647) and id or nil
    local link = call(GetQuestItemLink, kind, index)
    -- Exact links must not be truncated into a different/invalid variant.
    if not public(link) or type(link) ~= "string" or #link > 512 or not link:find("item:%d+") then
        return item
    end
    local details = exactItem(link, budget)
    for key, value in pairs(details) do
        item[key] = value
    end
    item.comparisons = {}
    for _, slot in ipairs(slots[item.equipLocation] or {}) do
        local equippedLink = call(GetInventoryItemLink, "player", slot)
        local equipped = { status = "unknown", capturedAt = time() }
        if
            public(equippedLink)
            and type(equippedLink) == "string"
            and #equippedLink <= 512
            and equippedLink:find("item:%d+")
        then
            equipped = exactItem(equippedLink, budget)
        end
        local clipped = equipped.truncated == true
        item.comparisons[#item.comparisons + 1] =
            { slot = slot, equipped = equipped, truncated = clipped }
        if clipped then
            item.comparisonsTruncated = true
        end
    end
    item.truncated = item.nameTruncated == true
        or item.equipLocationTruncated == true
        or item.statsTruncated == true
        or item.comparisonsTruncated == true
    return item
end

local function section(kind, count, budget)
    local result = {
        status = "unknown",
        capturedAt = time(),
        source = "Forever current turn-in dialog",
        options = {},
    }
    if not integer(count, 0, 1000000) then
        return result
    end
    result.status, result.count, result.truncated = "available", count, count > 10
    result.optionsTruncated = count > 10
    for index = 1, math.min(count, 10) do
        local item = option(kind, index, budget)
        result.options[#result.options + 1] = item
        if item.truncated then
            result.truncated = true
        end
    end
    return result
end

function ns.Character.ReadQuestRewards()
    assert(visible(), "Keep the player-opened quest turn-in reward dialog visible first")
    assert(
        GetQuestID
            and GetNumQuestChoices
            and GetNumQuestRewards
            and GetQuestItemInfo
            and GetQuestItemLink,
        "Forever quest reward APIs are unavailable"
    )
    local revision, quest = generation, call(GetQuestID)
    -- Aggregate raw-stat budget bounds the response even with distinct long stat keys.
    local budget = { stats = 128 }
    assert(integer(quest, 1, 2147483647), "Current quest identity is unknown")
    local title, titleTruncated = text(call(GetTitleText), 200)
    local data = {
        questId = quest,
        title = title,
        titleTruncated = titleTruncated,
        generation = revision,
        source = "Forever current turn-in dialog; exact item links",
        capturedAt = time(),
        choices = section("choice", call(GetNumQuestChoices), budget),
        guaranteed = section("reward", call(GetNumQuestRewards), budget),
        note = "Only choices are mutually exclusive. Raw exact-link stats, not DPS or weights; procs, sets and combined two-hand/off-hand replacements are not evaluated. Missing data is unknown. No selection or claim performed. Other reward types are outside this item observation.",
    }
    data.truncated = data.titleTruncated == true
        or data.choices.truncated == true
        or data.guaranteed.truncated == true
    local current = call(GetQuestID)
    assert(
        visible()
            and revision == generation
            and integer(current, 1, 2147483647)
            and current == quest,
        "Quest dialog changed during observation; discard this offer"
    )
    return data
end
