local helper = require("addon.tests.support")

local function setup(_ENV)
    do
        C = {}
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
    helper.addon("Character.lua", _ENV)
end

it(
    "turn snapshots revalidate quests but send an unchanged log only until its revision is acknowledged",
    function()
        local _ENV = helper.env()
        setup(_ENV)

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
        local first = C.CaptureTurn()
        assert(first.questRevision == 1 and first.sections.quests.data.count == 1)
        assert(first.sections.quests.data.quests[1].objectives[1].unused == nil)
        C.questAcknowledged = 1
        local second = C.CaptureTurn()
        assert(
            reads == 2 and second.questRevision == 1 and second.sections.quests == nil,
            "revalidate without resending"
        )
        complete = true
        local third = C.CaptureTurn()
        assert(third.questRevision == 2 and third.sections.quests.data.quests[1].complete)
        assert(C.CaptureTurn().sections.quests ~= nil, "lost/unconfirmed revisions must resend")
        C.questAcknowledged = 2
        assert(C.CaptureTurn().sections.quests == nil)
        count = 42
        local bounded = C.CaptureTurn().sections.quests.data
        assert(bounded.count == 42 and bounded.truncated and #bounded.quests == 40)
        C_QuestLog.GetNumQuestLogEntries = function()
            error("not ready")
        end
        local failed = C.CaptureTurn()
        assert(
            failed.questRevision == nil and failed.sections.quests == nil,
            "never reuse stale data on failure"
        )
    end
)

it(
    "quest reward XP survives live reads and synchronized snapshots, including zero and unavailable values",
    function()
        local _ENV = helper.env()
        setup(_ENV)

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
        assert(C.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == 850)
        local first = C.CaptureTurn()
        assert(first.sections.quests.data.quests[1].rewardXP == 850)
        C.questAcknowledged = first.questRevision
        assert(C.CaptureTurn().sections.quests == nil)
        xp = 0
        local changed = C.CaptureTurn()
        assert(changed.questRevision > first.questRevision)
        assert(changed.sections.quests.data.quests[1].rewardXP == 0)
        for _, invalid in ipairs({ -1, "850", math.huge, 0 / 0 }) do
            xp = invalid
            assert(C.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil)
        end
        GetQuestLogRewardXP = function()
            error("not ready")
        end
        assert(C.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil)
        assert(C.CaptureTurn().sections.quests.data.quests[1].rewardXP == nil)
        GetQuestLogRewardXP = nil
        assert(C.Capture({ "quests" }).sections.quests.data.quests[1].rewardXP == nil)
    end
)

it(
    "turn context sends only changed character identity and excludes unrelated live fields",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        local level = 13
        C.Capture = function()
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
        local first = C.CaptureTurn()
        assert(first.characterRevision == 1 and first.sections.character.data.level == 13)
        assert(
            first.sections.character.data.moneyCopper == nil
                and first.sections.character.data.xp == nil
                and first.sections.character.data.raceToken == nil
        )
        assert(first.source == nil and first.character == nil)
        C.characterAcknowledged = 1
        local second = C.CaptureTurn()
        assert(second.characterRevision == 1 and second.sections.character == nil)
        level = 14
        local third = C.CaptureTurn()
        assert(third.characterRevision == 2 and third.sections.character.data.level == 14)
    end
)

it(
    "reference reads distinguish loading from a missing item and expose real tooltip text",
    function()
        local _ENV = helper.env()
        setup(_ENV)

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
        local r = C.Inspect({ kind = "reference", args = { kind = "item", id = 1 } })
        assert(
            r.status == "available"
                and r.data.requiredLevel == 5
                and r.data.tooltip[1].left == "Requires Level 5"
        )
        r = C.Inspect({ kind = "reference", args = { kind = "item", id = 2 } })
        assert(r.data.status == "loading" and requested == 2)
        assert(
            C.Inspect({ kind = "reference", args = { kind = "spell", id = 3 } }).status
                == "unavailable"
        )
    end
)

it("progression preserves false completion separately from unavailable data", function()
    local _ENV = helper.env()
    setup(_ENV)

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
    local d = C.Inspect({
        kind = "progression",
        args = { questIds = { 1, 2, 3 }, factionIds = { 10 } },
    }).data
    assert(d.completion[1].completed == true)
    assert(d.completion[2].completed == false and d.completion[2].status == "available")
    assert(d.completion[3].status == "unavailable" and d.completion[3].completed == nil)
    assert(d.reputations[1].status == "unavailable")
end)

it("trainer reads require an open window and use the Forever service return fields", function()
    local _ENV = helper.env()
    setup(_ENV)

    assert(C.Inspect({ kind = "trainer" }).status == "unavailable")
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
    local d = C.Inspect({ kind = "trainer" }).data
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
        local _ENV = helper.env()
        setup(_ENV)

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
        local d = C.Inspect({ kind = "resources" }).data
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
    local _ENV = helper.env()
    setup(_ENV)

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
    local d = C.Inspect({ kind = "compare_items", args = { itemIds = { 5 } } }).data
    assert(#d.candidates[1].comparisons == 2)
    assert(
        d.candidates[1].comparisons[1].statDelta.INT == 4
            and d.candidates[1].comparisons[2].statDelta.INT == 3
    )
end)

it(
    "auction reads require the AH, keep stack/unit prices separate, and expose partial coverage",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        assert(C.Inspect({ kind = "auctions" }).status == "unavailable")
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
        local d = C.Inspect({ kind = "auctions", args = { itemId = 2589 } }).data
        assert(
            d.partial
                and d.totalSearchResults == 200
                and d.results[1].unitBuyoutCopper == 50
                and d.results[1].buyoutCopper == 1000
        )
        local other = C.Inspect({ kind = "auctions", args = { itemId = 999 } }).data
        assert(#other.results == 0 and other.partial)
    end
)

it("target inspection uses the selected NPC identity and does not fabricate coordinates", function()
    local _ENV = helper.env()
    setup(_ENV)

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
        return table.unpack(parts)
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
    local d = C.Inspect({ kind = "target" }).data
    assert(d.npcId == 456 and d.level == 11 and d.attackable and d.x == nil)
    UnitExists = function()
        return false
    end
    assert(C.Inspect({ kind = "target" }).status == "unavailable")
end)

it("modern auction browse output stays labelled as cached partial data", function()
    local _ENV = helper.env()
    setup(_ENV)

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
    local d = C.Inspect({ kind = "auctions", args = { itemId = 2589, limit = 1 } }).data
    assert(
        d.partial
            and d.loadedResults == 1
            and d.results[1].minimumPriceCopper == 50
            and d.results[1].totalQuantity == 200
            and d.pricesAsOf:find("unknown")
    )
end)
