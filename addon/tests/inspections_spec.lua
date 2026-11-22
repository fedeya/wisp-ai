local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function UnitName(unit)
            return unit == "npc" and "Trainer" or "Mage"
        end
        function GetMoney()
            return 500
        end
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
    end
    helper.addon("Character/Capture.lua", env)
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Actions/Game.lua", env)
end

it("reads an item cooldown only when requested and keeps the usual item details", function()
    local env = helper.env()
    setup(env)
    env.C_Item = {
        GetItemInfo = function()
            return "Mana Potion", "item:3827"
        end,
    }
    env.GetTime = function()
        return 110
    end
    local cooldownId
    env.C_Container = {
        GetItemCooldown = function(itemId)
            cooldownId = itemId
            return 100, 40, 1
        end,
    }
    local request = { kind = "reference", args = { kind = "item", id = 3827 } }
    local details = env.ns.Character.Inspect(request).data
    assert.equals("Mana Potion", details.name)
    assert.is_nil(details.cooldown)
    assert.is_nil(cooldownId)

    request.args.includeCooldown = true
    details = env.ns.Character.Inspect(request).data
    assert.equals(3827, cooldownId)
    assert.equals("Mana Potion", details.name)
    assert.same({
        status = "available",
        state = "cooldown",
        remainingSeconds = 30,
    }, details.cooldown)

    request.args.id = 6948
    env.C_Container = nil
    env.C_Item.GetItemInfo = function()
        return nil
    end
    env.C_Item.GetItemCooldown = function(itemId)
        cooldownId = itemId
        return 0, 0, true
    end
    details = env.ns.Character.Inspect(request).data
    assert.equals(6948, cooldownId)
    assert.equals("loading", details.status)
    assert.same({
        status = "available",
        state = "no_active_cooldown",
        remainingSeconds = 0,
    }, details.cooldown)
end)

it("keeps restricted or disabled item timers unknown", function()
    local env = helper.env()
    setup(env)
    local restricted = {}
    env.issecretvalue = function(value)
        return value == restricted
    end
    env.GetTime = function()
        return 110
    end
    env.C_Item = {
        GetItemCooldown = function()
            return restricted, 0, true
        end,
    }
    local request = {
        kind = "reference",
        args = { kind = "item", id = 3827, includeCooldown = true },
    }
    local unknown = { status = "unavailable", state = "unknown" }
    local details = env.ns.Character.Inspect(request).data
    assert.equals("unavailable", details.status)
    assert.same(unknown, details.cooldown)
    env.C_Item.GetItemCooldown = function()
        return 0, 0, false
    end
    assert.same(unknown, env.ns.Character.Inspect(request).data.cooldown)
end)

it("reads a spell cooldown on demand without counting the global cooldown", function()
    local env = helper.env()
    setup(env)
    local calls, remainingReads, remaining, secret = 0, 0, 12.5, false
    local duration = {
        HasSecretValues = function()
            return secret
        end,
        GetRemainingDuration = function()
            remainingReads = remainingReads + 1
            return remaining
        end,
    }
    env.C_Spell = {
        GetSpellInfo = function()
            return { name = "Blink" }
        end,
        GetSpellCooldownDuration = function(id, ignoreGCD)
            calls = calls + 1
            assert.equals(1953, id)
            assert.is_true(ignoreGCD)
            return duration
        end,
    }
    local request = { kind = "reference", args = { kind = "spell", id = 1953 } }
    local details = env.ns.Character.Inspect(request).data
    assert.is_nil(details.cooldown)
    assert.equals(0, calls)

    request.args.includeCooldown = true
    details = env.ns.Character.Inspect(request).data
    assert.equals("Blink", details.info.name)
    assert.same({
        status = "available",
        state = "cooldown",
        remainingSeconds = 12.5,
    }, details.cooldown)

    remaining = 0
    assert.same({
        status = "available",
        state = "no_active_cooldown",
        remainingSeconds = 0,
    }, env.ns.Character.Inspect(request).data.cooldown)

    secret = true
    local unknown = { status = "unavailable", state = "unknown" }
    assert.same(unknown, env.ns.Character.Inspect(request).data.cooldown)
    assert.equals(2, remainingReads)
    env.C_Spell.GetSpellCooldownDuration = nil
    assert.same(unknown, env.ns.Character.Inspect(request).data.cooldown)
end)

it("reads just the localized Hearthstone bind without inspecting the item", function()
    local env = helper.env()
    setup(env)
    local name = "Villa Dorada"
    env.GetBindLocation = function()
        return name
    end
    local request = { kind = "hearthstone" }
    assert.same({
        bind = { status = "available", name = name },
    }, env.ns.Character.Inspect(request).data)
    name = " "
    assert.same({ bind = { status = "unavailable" } }, env.ns.Character.Inspect(request).data)
end)

it(
    "turn snapshots revalidate quests but send an unchanged log only until its revision is acknowledged",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local complete, count, reads = false, 1, 0
        C_QuestLog = {
            GetNumQuestLogEntries = function()
                reads = reads + 1
                return count
            end,
            GetInfo = function(i)
                return { questID = i, title = "Quest " .. i, level = 12 }
            end,
            IsComplete = function()
                return complete
            end,
            GetQuestObjectives = function()
                return {
                    {
                        text = "Deliver crate",
                        finished = complete,
                        numFulfilled = 0,
                        numRequired = 1,
                        unused = "omit",
                    },
                }
            end,
        }
        C_EncodingUtil = {
            SerializeJSON = function(data)
                return tostring(data.count) .. tostring(data.quests[1].complete)
            end,
        }
        local first = ns.Character.CaptureTurn()
        assert(first.questRevision == 1 and first.sections.quests.data.count == 1)
        assert(first.sections.quests.data.quests[1].objectives[1].unused == nil)
        ns.questAcknowledged = 1
        local second = ns.Character.CaptureTurn()
        assert(
            reads == 2 and second.questRevision == 1 and second.sections.quests == nil,
            "revalidate without resending"
        )
        complete = true
        local third = ns.Character.CaptureTurn()
        assert(third.questRevision == 2 and third.sections.quests.data.quests[1].complete)
        assert(
            ns.Character.CaptureTurn().sections.quests ~= nil,
            "lost/unconfirmed revisions must resend"
        )
        ns.questAcknowledged = 2
        assert(ns.Character.CaptureTurn().sections.quests == nil)
        count = 42
        local bounded = ns.Character.CaptureTurn().sections.quests.data
        assert(bounded.count == 42 and bounded.truncated and #bounded.quests == 40)
        C_QuestLog.GetNumQuestLogEntries = function()
            error("not ready")
        end
        local failed = ns.Character.CaptureTurn()
        assert(
            failed.questRevision == nil and failed.sections.quests == nil,
            "never reuse stale data on failure"
        )
    end
)

it(
    "quest reward XP survives live reads and synchronized snapshots, including zero and unavailable values",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local xp = 850
        C_QuestLog = {
            GetNumQuestLogEntries = function()
                return 1
            end,
            GetInfo = function()
                return { questID = 1492, title = "Delivery", level = 12 }
            end,
            IsComplete = function()
                return false
            end,
            GetQuestObjectives = function()
                return {}
            end,
        }
        GetQuestLogRewardXP = function(id)
            assert(id == 1492)
            return xp
        end
        C_EncodingUtil = {
            SerializeJSON = function(data)
                return tostring(data.quests[1].rewardXP)
            end,
        }
        assert(ns.Character.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == 850)
        local first = ns.Character.CaptureTurn()
        assert(first.sections.quests.data.quests[1].rewardXP == 850)
        ns.questAcknowledged = first.questRevision
        assert(ns.Character.CaptureTurn().sections.quests == nil)
        xp = 0
        local changed = ns.Character.CaptureTurn()
        assert(changed.questRevision > first.questRevision)
        assert(changed.sections.quests.data.quests[1].rewardXP == 0)
        for _, invalid in ipairs({ -1, "850", math.huge, 0 / 0 }) do
            xp = invalid
            assert(
                ns.Character.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil
            )
        end
        GetQuestLogRewardXP = function()
            error("not ready")
        end
        assert(ns.Character.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil)
        assert(ns.Character.CaptureTurn().sections.quests.data.quests[1].rewardXP == nil)
        GetQuestLogRewardXP = nil
        assert(ns.Character.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil)
    end
)

it(
    "turn context sends only changed character identity and excludes unrelated live fields",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local level = 13
        ns.Character.Capture = function()
            return {
                capturedAt = 123,
                source = "WoW addon live API",
                character = "Mage",
                sections = {
                    character = {
                        status = "available",
                        data = {
                            name = "Mage",
                            realm = "Realm",
                            class = "MAGE",
                            level = level,
                            moneyCopper = 999,
                            xp = 100,
                            xpMax = 1000,
                            raceToken = "ORC",
                        },
                    },
                    location = { status = "available", data = { zone = "Test" } },
                },
            }
        end
        C_EncodingUtil = {
            SerializeJSON = function(data)
                return tostring(data.level)
            end,
        }
        local first = ns.Character.CaptureTurn()
        assert(first.characterRevision == 1 and first.sections.character.data.level == 13)
        assert(
            first.sections.character.data.moneyCopper == nil
                and first.sections.character.data.xp == nil
                and first.sections.character.data.raceToken == nil
        )
        assert(first.source == nil and first.character == nil)
        ns.characterAcknowledged = 1
        local second = ns.Character.CaptureTurn()
        assert(second.characterRevision == 1 and second.sections.character == nil)
        level = 14
        local third = ns.Character.CaptureTurn()
        assert(third.characterRevision == 2 and third.sections.character.data.level == 14)
    end
)

it(
    "reference reads distinguish loading from a missing item and expose real tooltip text",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local requested
        C_Item = {
            GetItemInfo = function(id)
                if id == 1 then
                    return "Robe", "item:1", 2, 10, 5, "Armor", "Cloth", 1, "INVTYPE_ROBE", 0, 40
                end
            end,
            RequestLoadItemDataByID = function(id)
                requested = id
            end,
            GetItemStats = function()
                return { INT = 2 }
            end,
        }
        C_TooltipInfo = {
            GetHyperlink = function()
                return { lines = { { leftText = "Requires Level 5" } } }
            end,
        }
        local r = ns.Character.Inspect({ kind = "reference", args = { kind = "item", id = 1 } })
        assert(
            r.status == "available"
                and r.data.requiredLevel == 5
                and r.data.tooltip[1].left == "Requires Level 5"
        )
        r = ns.Character.Inspect({ kind = "reference", args = { kind = "item", id = 2 } })
        assert(r.data.status == "loading" and requested == 2)
        assert(
            ns.Character.Inspect({ kind = "reference", args = { kind = "spell", id = 3 } }).status
                == "unavailable"
        )
    end
)

it("progression preserves false completion separately from unavailable data", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_QuestLog = {
        GetNumQuestLogEntries = function()
            return 0
        end,
        IsQuestFlaggedCompleted = function(id)
            if id == 3 then
                error("unknown")
            end
            return id == 1
        end,
    }
    local d = ns.Character.Inspect({
        kind = "progression",
        args = { questIds = { 1, 2, 3 }, factionIds = { 10 } },
    }).data
    assert(d.completion[1].completed == true)
    assert(d.completion[2].completed == false and d.completion[2].status == "available")
    assert(d.completion[3].status == "unavailable" and d.completion[3].completed == nil)
    assert(d.reputations[1].status == "unavailable")
end)

it("trainer reads require an open window and use the Forever service return fields", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(ns.Character.Inspect({ kind = "trainer" }).status == "unavailable")
    ClassTrainerFrame = {
        IsShown = function()
            return true
        end,
    }
    GetNumTrainerServices = function()
        return 1
    end
    GetTrainerServiceInfo = function()
        return "Frost Nova", "available", 123, 10, "Rank 1", "Frost"
    end
    GetTrainerServiceCost = function()
        return 200
    end
    BuyTrainerService = function()
        error("must not train")
    end
    local d = ns.Character.Inspect({ kind = "trainer" }).data
    assert(
        d.services[1].requiredLevel == 10
            and d.services[1].rank == "Rank 1"
            and d.services[1].costCopper == 200
            and d.services[1].status == "available"
    )
end)

it(
    "resource reads report collapsed skills and never turn unavailable bag space into zero",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        NUM_BAG_SLOTS = 1
        C_Container = {
            GetContainerNumSlots = function()
                return 2
            end,
            GetContainerItemInfo = function()
                return nil
            end,
        }
        C_SkillInfo = {
            GetNumSkillLines = function()
                return 2
            end,
            GetSkillLineInfo = function(i)
                if i == 1 then
                    return { isHeader = true, isCollapsed = true }
                else
                    return { name = "Tailoring", skillID = 197, rank = 10, maxRank = 75 }
                end
            end,
        }
        local d = ns.Character.Inspect({ kind = "resources" }).data
        assert(
            d.moneyCopper == 500
                and d.bagCapacity == 4
                and d.freeBagSlots == nil
                and d.collapsedSkills
        )
        assert(d.skills[1].rank == 10 and d.skillsStatus == "available")
    end
)

it("comparison considers both ring slots without converting raw deltas to DPS", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_Item = {
        GetItemInfo = function(id)
            return "Ring", "item:" .. id, 2, 10, 5, "Armor", "Ring", 1, "INVTYPE_FINGER", 0, 40
        end,
        GetItemStats = function(link)
            return { INT = tonumber(link:match(":(%d+)")) }
        end,
    }
    GetInventoryItemID = function(unit, slot)
        return slot == 11 and 1 or 2
    end
    local d = ns.Character.Inspect({ kind = "compare_items", args = { itemIds = { 5 } } }).data
    assert(#d.candidates[1].comparisons == 2)
    assert(
        d.candidates[1].comparisons[1].statDelta.INT == 4
            and d.candidates[1].comparisons[2].statDelta.INT == 3
    )
end)

it(
    "auction reads require the AH, keep stack/unit prices separate, and expose partial coverage",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        assert(ns.Character.Inspect({ kind = "auctions" }).status == "unavailable")
        AuctionFrame = {
            IsShown = function()
                return true
            end,
        }
        GetRealmName = function()
            return "Realm"
        end
        UnitFactionGroup = function()
            return "Horde"
        end
        GetNumAuctionItems = function()
            return 1, 200
        end
        GetAuctionItemInfo = function()
            return "Cloth", 0, 20, 1, true, 1, 0, 100, 1, 1000, 0, false, 0, "Seller", nil, 0, 2589
        end
        QueryAuctionItems = function()
            error("must not scan")
        end
        PlaceAuctionBid = function()
            error("must not buy")
        end
        local d = ns.Character.Inspect({ kind = "auctions", args = { itemId = 2589 } }).data
        assert(
            d.partial
                and d.totalSearchResults == 200
                and d.results[1].unitBuyoutCopper == 50
                and d.results[1].buyoutCopper == 1000
        )
        local other = ns.Character.Inspect({ kind = "auctions", args = { itemId = 999 } }).data
        assert(#other.results == 0 and other.partial)
    end
)

it("target inspection uses the selected NPC identity and does not fabricate coordinates", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    UnitExists = function()
        return true
    end
    UnitGUID = function()
        return "Creature-0-1-2-3-456-abc"
    end
    strsplit = function(_, text)
        local parts = {}
        for part in text:gmatch("[^-]+") do
            parts[#parts + 1] = part
        end
        return unpack(parts)
    end
    UnitLevel = function()
        return 11
    end
    UnitClassification = function()
        return "normal"
    end
    UnitIsPlayer = function()
        return false
    end
    UnitFactionGroup = function()
        return "Horde"
    end
    UnitReaction = function()
        return 3
    end
    UnitCanAttack = function()
        return true
    end
    UnitIsDead = function()
        return false
    end
    local d = ns.Character.Inspect({ kind = "target" }).data
    assert(d.npcId == 456 and d.level == 11 and d.attackable and d.x == nil)
    UnitExists = function()
        return false
    end
    assert(ns.Character.Inspect({ kind = "target" }).status == "unavailable")
end)

it("modern auction browse output stays labelled as cached partial data", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    AuctionHouseFrame = {
        IsShown = function()
            return true
        end,
    }
    GetRealmName = function()
        return "Realm"
    end
    UnitFactionGroup = function()
        return "Horde"
    end
    C_AuctionHouse = {
        GetBrowseResults = function()
            return { { itemKey = { itemID = 2589 }, minPrice = 50, totalQuantity = 200 } }
        end,
        SendBrowseQuery = function()
            error("must not search")
        end,
    }
    local d = ns.Character.Inspect({ kind = "auctions", args = { itemId = 2589, limit = 1 } }).data
    assert(
        d.partial
            and d.loadedResults == 1
            and d.results[1].minimumPriceCopper == 50
            and d.results[1].totalQuantity == 200
            and d.pricesAsOf:find("unknown")
    )
end)

it("gear readings carry equipped item stats so slots need no separate inspection", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_Item = {
        GetItemInfo = function(link)
            if link == "item:7" then
                return "Staff", link, 2, 20, 15, "Weapon", "Staff", 1, "INVTYPE_2HWEAPON", 0, 90
            end
        end,
        GetItemStats = function()
            return { ITEM_MOD_INTELLECT_SHORT = 4 }
        end,
    }
    GetInventoryItemID = function(_, slot)
        return (slot == 16 and 7) or (slot == 1 and 9) or nil
    end
    GetInventoryItemLink = function(_, slot)
        return slot == 16 and "item:7" or "item:9"
    end
    local items = ns.Character.Capture({ "gear" }).sections.gear.data.items
    assert(items[1].slot == 1 and items[1].link == "item:9" and items[1].stats == nil)
    local staff = items[2]
    assert(
        staff.slot == 16
            and staff.name == "Staff"
            and staff.itemLevel == 20
            and staff.requiredLevel == 15
            and staff.equipLocation == "INVTYPE_2HWEAPON"
            and staff.stats.ITEM_MOD_INTELLECT_SHORT == 4
    )
end)

it(
    "ranking keeps level-appropriate candidates against the weakest slot and reports uncached ones",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local items = {
            -- id = { name, quality, itemLevel, requiredLevel, equipLocation, intellect }
            [1] = { "Old Ring", 2, 10, 5, "INVTYPE_FINGER", 1 },
            [2] = { "Older Ring", 2, 6, 1, "INVTYPE_FINGER", 1 },
            [10] = { "Good Ring", 2, 22, 18, "INVTYPE_FINGER", 5 },
            [11] = { "Later Ring", 3, 30, 25, "INVTYPE_FINGER", 9 },
            [12] = { "Small Ring", 2, 12, 8, "INVTYPE_FINGER", 2 },
            [13] = { "Linen", 1, 5, 0, "", nil },
        }
        local requested = {}
        C_Item = {
            GetItemInfo = function(id)
                local item = items[id]
                if item then
                    return item[1],
                        "item:" .. id,
                        item[2],
                        item[3],
                        item[4],
                        "Armor",
                        "Misc",
                        1,
                        item[5]
                end
            end,
            GetItemStats = function(link)
                local item = items[tonumber(link:match(":(%d+)"))]
                return item[6] and { ITEM_MOD_INTELLECT_SHORT = item[6] } or nil
            end,
            RequestLoadItemDataByID = function(id)
                requested[#requested + 1] = id
            end,
        }
        UnitLevel = function()
            return 21
        end
        GetInventoryItemID = function(_, slot)
            return (slot == 11 and 1) or (slot == 12 and 2) or nil
        end

        local d = ns.Character.Inspect({
            kind = "gear_candidates",
            args = { itemIds = { 10, 11, 12, 13, 99 } },
        }).data
        assert(d.status == "loading" and d.loadingIds[1] == 99 and requested[1] == 99)
        assert(
            d.counts.requested == 5
                and d.counts.matching == 2
                and d.counts.tooHighLevel == 1
                and d.counts.notEquipment == 1
        )
        local best = d.items[1]
        -- Ring 10 replaces the weaker equipped ring (slot 12, item level 6).
        assert(best.id == 10 and best.slot == 12 and best.itemLevelGain == 16)
        assert(best.equipped.id == 2 and best.statDelta.ITEM_MOD_INTELLECT_SHORT == 4)
        assert(best.link == nil and d.items[2].id == 12 and #d.items == 2)

        d = ns.Character.Inspect({
            kind = "gear_candidates",
            args = { itemIds = { 10, 11, 12 }, maxRequiredLevel = 30, minRequiredLevel = 20 },
        }).data
        assert(d.status == "available" and d.loadingIds == nil)
        assert(#d.items == 1 and d.items[1].id == 11 and d.counts.tooLowLevel == 2)
    end
)

it("gear candidates wait for an uncached equipped item instead of treating it as empty", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local cached = { [10] = true }
    C_Item = {
        GetItemInfo = function(id)
            if cached[id] then
                return "Item " .. id,
                    "item:" .. id,
                    2,
                    id == 10 and 22 or 12,
                    15,
                    "Armor",
                    "Misc",
                    1,
                    "INVTYPE_FEET"
            end
        end,
        GetItemStats = function()
            return { ITEM_MOD_INTELLECT_SHORT = 2 }
        end,
        RequestLoadItemDataByID = function() end,
    }
    UnitLevel = function()
        return 21
    end
    GetInventoryItemID = function(_, slot)
        return slot == 8 and 77 or nil
    end

    local d = ns.Character.Inspect({ kind = "gear_candidates", args = { itemIds = { 10 } } }).data
    assert(d.status == "loading" and d.loadingIds[1] == 77)
    assert(d.items[1].itemLevelGain == nil and d.items[1].statDelta == nil)
    assert(d.items[1].equipped.id == 77 and d.items[1].equipped.status == "loading")

    cached[77] = true
    d = ns.Character.Inspect({ kind = "gear_candidates", args = { itemIds = { 10 } } }).data
    assert(d.status == "available" and d.items[1].itemLevelGain == 10 and d.items[1].slot == 8)
end)

it("gear candidates leave stat differences unknown when equipped stats are unread", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_Item = {
        GetItemInfo = function(id)
            return "Item " .. id,
                "item:" .. id,
                2,
                id == 10 and 22 or 12,
                15,
                "Armor",
                "Misc",
                1,
                "INVTYPE_FEET"
        end,
        GetItemStats = function(link)
            if link == "item:10" then
                return { ITEM_MOD_INTELLECT_SHORT = 4 }
            end
        end,
        RequestLoadItemDataByID = function() end,
    }
    UnitLevel = function()
        return 21
    end
    GetInventoryItemID = function(_, slot)
        return slot == 8 and 77 or nil
    end

    local item =
        ns.Character.Inspect({ kind = "gear_candidates", args = { itemIds = { 10 } } }).data.items[1]
    assert(item.statDelta == nil and item.itemLevelGain == 10 and item.equipped.id == 77)

    GetInventoryItemID = function()
        return nil
    end
    item =
        ns.Character.Inspect({ kind = "gear_candidates", args = { itemIds = { 10 } } }).data.items[1]
    assert(item.emptySlot and item.statDelta.ITEM_MOD_INTELLECT_SHORT == 4)
end)
