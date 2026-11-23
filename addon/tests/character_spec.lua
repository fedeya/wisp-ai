local helper = require("addon.tests.support")

local function setupFrame(env)
    setfenv(1, env)
    do
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
    end
end

local function setupTalents(env)
    setfenv(1, env)
    do
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
    end
    do
        ns = helper.namespace()
        function UnitName()
            return "Testmage"
        end
        function time()
            return 123
        end
        free = 2
        pending = true
        C_SpecializationInfo = {
            GetActiveSpecGroup = function()
                return 1
            end,
            GetCombatConfigIDForSpecGroup = function(group)
                assert(group == 1)
                return 55
            end,
        }
        C_Spell = {
            GetSpellName = function()
                return "Improved Frostbolt"
            end,
        }
        C_Traits = {
            GetConfigInfo = function()
                return { treeIDs = { 10, 20 } }
            end,
            ConfigHasStagedChanges = function()
                return pending
            end,
            GetTreeNodes = function(tree)
                return tree == 10 and { 1 } or {}
            end,
            GetNodeInfo = function()
                return {
                    activeRank = 3,
                    maxRanks = 5,
                    activeEntry = { entryID = 2 },
                    groupIDs = { 999, 42 },
                }
            end,
            GetEntryInfo = function()
                return { definitionID = 3 }
            end,
            GetDefinitionInfo = function()
                return { spellID = 11070 }
            end,
            GetGroupDisplayInfoByTreeID = function()
                return { { groupID = 42, displayName = "Frost" } }
            end,
            GetTreeCurrencyInfo = function(config, tree, exclude)
                assert(config == 55)
                return {
                    {
                        traitCurrencyID = 3820,
                        quantity = exclude and free or 0,
                        spent = exclude and 3 or 5,
                        maxQuantity = 5,
                    },
                }
            end,
        }
    end
    helper.addon("Character/Capture.lua", env)
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Actions/Game.lua", env)
end

local function setupSnapshot(env)
    setfenv(1, env)
    do
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
    end
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function GetTime()
            return 5
        end
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        SlashCmdList = {}
        C_EncodingUtil = {
            DeserializeJSON = function()
                return SNAPSHOT
            end,
        }
    end
    helper.addon("Core.lua", env)
end

local function setupCore(env)
    setfenv(1, env)
    do
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
    end
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function GetTime()
            return 5
        end
        SlashCmdList = {}
        C_EncodingUtil = {
            DeserializeJSON = function()
                return SNAPSHOT
            end,
        }
    end
    helper.addon("Core.lua", env)
end

it(
    "first visible text is measured once for the current message, excluding old or hidden rows",
    function()
        local env = helper.env()
        setfenv(1, env)
        setupFrame(env)
        do
            ns = helper.namespace()
            SlashCmdList = {}
            now = 0
            function time()
                return 123
            end
            function GetTime()
                return now
            end
            callbacks = {}
            C_Timer = {
                After = function(_, f)
                    callbacks[#callbacks + 1] = f
                end,
            }
        end
        helper.addon("Core.lua", env)

        local sent = {}
        ns.Transport.Send = function(p)
            sent[#sent + 1] = p
        end
        local old = { role = "assistant", text = "old" }
        local answer = { role = "assistant", text = "new" }
        local chat = {
            id = "chat",
            messages = { old, { role = "user", id = "m", text = "question" }, answer },
        }
        local visible = false
        local row = {
            IsShown = function()
                return true
            end,
            IsVisible = function()
                return visible
            end,
        }
        ns.Transport.BeginResponseTiming("chat", "m", 0)
        ns.responseTiming.chat.acknowledgedAt = 1
        ns.Transport.RecordFirstText(chat, old, row)
        assert(#callbacks == 0)
        now = 3
        ns.Transport.RecordFirstText(chat, answer, row)
        callbacks[1]()
        assert(#sent == 0, "hidden text is not displayed text")
        visible = true
        ns.Transport.RecordFirstText(chat, answer, row)
        callbacks[2]()
        assert(#sent == 1 and sent[1].data.totalMs == 3000 and sent[1].data.afterSendingMs == 2000)
        ns.Transport.RecordFirstText(chat, answer, row)
        assert(#callbacks == 2, "measure only the first display")
    end
)

it(
    "talent points use the applied API count, distinguish previews, and deduplicate shared pools",
    function()
        local env = helper.env()
        setfenv(1, env)
        setupTalents(env)

        local t = ns.Character.Capture({ "talents" }).sections.talents
        assert(t.status == "available")
        local d = t.data
        assert(
            d.unspentStatus == "known"
                and d.unspentPoints == 2
                and d.spentPoints == 3
                and d.totalPoints == 5
        )
        assert(#d.currencies == 1, "a pool shared by trees must not be added twice")
        assert(d.hasPendingChanges and d.previewUnspentPoints == 0)
        assert(
            d.selected[1].rank == 3
                and d.selected[1].maxRank == 5
                and d.selected[1].branch == "Frost"
        )
        free = 0
        pending = false
        d = ns.Character.Capture({ "talents" }).sections.talents.data
        assert(d.unspentStatus == "known" and d.unspentPoints == 0, "zero is a valid fresh reading")
        assert(d.previewUnspentPoints == nil)
    end
)

it(
    "failed or ambiguous talent currencies remain unknown while selected talents stay available",
    function()
        local env = helper.env()
        setfenv(1, env)
        setupTalents(env)

        C_Traits.GetTreeCurrencyInfo = function()
            error("not ready")
        end
        local d = ns.Character.Capture({ "talents" }).sections.talents.data
        assert(d.unspentStatus == "unknown" and d.unspentPoints == nil and #d.selected == 1)
        C_Traits.GetTreeCurrencyInfo = function(config, tree)
            return { { traitCurrencyID = tree, quantity = 1, spent = 0, maxQuantity = 1 } }
        end
        d = ns.Character.Capture({ "talents" }).sections.talents.data
        assert(d.unspentStatus == "unknown" and d.unspentPoints == nil and #d.currencies == 2)
        C_Traits.GetTreeCurrencyInfo = function()
            return {}
        end
        d = ns.Character.Capture({ "talents" }).sections.talents.data
        assert(d.unspentStatus == "unknown" and d.unspentPoints == nil)
    end
)

it("character sections are read only on demand and every call is fresh", function()
    local env = helper.env()
    setfenv(1, env)
    setupFrame(env)
    do
        ns = helper.namespace()
        calls = 0
        currentLevel = 10
        function UnitName()
            return "Testmage"
        end
        function time()
            return 123
        end
        function UnitLevel()
            calls = calls + 1
            return currentLevel
        end
        function UnitClass()
            return "Mage", "MAGE"
        end
        function UnitRace()
            return "Orc"
        end
        function UnitFactionGroup()
            return "Horde"
        end
        function GetRealmName()
            return "Realm"
        end
        function GetBuildInfo()
            return "1.60.1", "70840"
        end
        function GetMoney()
            return 123
        end
        function UnitXP()
            return 1
        end
        function UnitXPMax()
            return 100
        end
    end
    helper.addon("Character/Capture.lua", env)
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Actions/Game.lua", env)

    assert(calls == 0)
    local s = ns.Character.Capture({ "character" })
    assert(s.sections.character.data.level == 10)
    assert(calls == 1)
    currentLevel = 11
    local t = ns.Character.Capture({ "character" })
    assert(t.sections.character.data.level == 11)
    assert(calls == 2)
end)

local function setupGroup(env, members, raid)
    setfenv(1, env)
    setupFrame(env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        local byUnit = {}
        for index, member in ipairs(members) do
            byUnit[raid and ("raid" .. index) or member.unit] = member
        end
        for _, member in ipairs(members) do
            if member.player then
                byUnit.player = member
            end
        end
        local function get(unit)
            return assert(byUnit[unit], "unexpected unit " .. unit)
        end
        function IsInGroup()
            return #members > 1
        end
        function IsInRaid()
            return raid
        end
        function GetNumGroupMembers()
            return #members
        end
        function IsInInstance()
            return true, "party"
        end
        function GetInstanceInfo()
            return "Wailing Caverns"
        end
        function UnitExists(unit)
            return byUnit[unit] ~= nil
        end
        function UnitIsUnit(unit, other)
            return other == "player" and unit ~= "player" and get(unit).player == true
                or unit == other
        end
        function UnitName(unit)
            return get(unit).name, get(unit).realm
        end
        function UnitClass(unit)
            return "Class", get(unit).class
        end
        function UnitLevel(unit)
            return get(unit).level
        end
        function UnitGroupRolesAssigned(unit)
            return get(unit).role or "NONE"
        end
        function UnitIsGroupLeader(unit)
            return get(unit).leader
        end
        function UnitIsConnected(unit)
            return get(unit).online ~= false
        end
        function UnitIsDeadOrGhost()
            return false
        end
        function UnitIsVisible(unit)
            return get(unit).visible
        end
        function UnitInRange(unit)
            return get(unit).visible, true
        end
        C_Map = {
            GetBestMapForUnit = function(unit)
                return unit == "player" and 279 or get(unit).map
            end,
            GetMapInfo = function(id)
                return { name = id == 279 and "Wailing Caverns" or "Ratchet" }
            end,
            GetPlayerMapPosition = function(_, unit)
                local position = get(unit).position
                return position
                    and {
                        GetXY = function()
                            return position[1], position[2]
                        end,
                    }
            end,
        }
    end
    helper.addon("Character/Capture.lua", env)
end

it("the group section lists each member and where the game says they are", function()
    local env = helper.env()
    setfenv(1, env)
    setupGroup(env, {
        { unit = "player", player = true, name = "Fedrath", class = "MAGE", level = 22 },
        {
            unit = "party1",
            name = "Sethra",
            class = "WARRIOR",
            level = 23,
            role = "TANK",
            leader = true,
            map = 279,
            visible = true,
        },
        {
            unit = "party2",
            name = "Fisherman",
            realm = "",
            class = "PRIEST",
            level = 21,
            role = "HEALER",
            map = 1413,
            position = { 0.62, 0.38 },
            visible = false,
        },
        { unit = "party3", name = "Away", class = "ROGUE", level = 20, online = false },
    })

    local group = ns.Character.Capture({ "group" }).sections.group
    assert(group.status == "available")
    local data = group.data
    assert(data.inGroup and not data.raid and data.size == 4)
    assert(data.instance.name == "Wailing Caverns" and data.instance.type == "party")
    assert(#data.members == 4)
    local player, tank, healer, away = unpack(data.members)
    assert(player.isPlayer and player.name == "Fedrath" and player.zone == nil)
    assert(tank.role == "tank" and tank.leader and tank.sameMap and tank.visible)
    assert(tank.inRange and tank.x == nil, "no coordinates inside instances")
    assert(healer.realm == nil and healer.role == "healer" and healer.zone == "Ratchet")
    assert(healer.sameMap == false and healer.x == 0.62 and healer.y == 0.38)
    assert(not away.online and away.zone == nil and away.visible == nil)

    UnitIsConnected, UnitIsGroupLeader = nil, nil
    function UnitIsVisible()
        error("not ready")
    end
    local unknown = ns.Character.Capture({ "group" }).sections.group.data.members[2]
    assert(unknown.online == nil and unknown.leader == nil and unknown.visible == nil)
    assert(unknown.zone == "Wailing Caverns", "an unknown connection still reads the place")
end)

it("raid units already include the player, and a solo character has no members", function()
    local env = helper.env()
    setfenv(1, env)
    setupGroup(env, {
        { name = "Leader", class = "WARRIOR", level = 60, leader = true, map = 279 },
        { player = true, name = "Fedrath", class = "MAGE", level = 60 },
    }, true)
    local raid = ns.Character.Capture({ "group" }).sections.group.data
    assert(raid.raid and #raid.members == 2 and raid.members[2].isPlayer)
    local turn = ns.Character.CaptureTurn().sections.group
    assert(
        turn.status == "available",
        "each turn carries only whether there is a group and its size"
    )
    assert(
        turn.data.inGroup and turn.data.raid and turn.data.size == 2 and turn.data.members == nil
    )

    setupGroup(env, { { unit = "player", player = true, name = "Fedrath" } })
    local solo = ns.Character.Capture({ "group" }).sections.group.data
    assert(not solo.inGroup and not solo.raid and solo.size == 1 and #solo.members == 0)
end)

local function setupPvp(env)
    setfenv(1, env)
    setupFrame(env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function UnitName()
            return "Fedrath"
        end
        function UnitFactionGroup()
            return "Horde"
        end
        function UnitSex()
            return 2
        end
        Enum = { PvPRanks = { Rank_1 = 5 } }
        PVP_RANK_0_NAME = "Civilian"
        function GetText(key, sex)
            assert(sex == 2)
            return key == "PVP_RANK_6_0" and "Grunt" or nil
        end
        Constants = { CurrencyConsts = { HONOR_CURRENCY_ID = 1792 } }
        totals = { [0] = 0, [1] = 100, [2] = 250, [3] = 450 }
        progression = {
            renownLevel = 2,
            renownReputationEarned = 40,
            renownLevelThreshold = 200,
            maxLevel = 14,
            currentWeekProgressiveMaxLevel = 3,
            previousWeekProgressiveMaxLevel = 1,
        }
        C_MajorFactions = {
            GetMajorFactionProgressionInfo = function(id)
                assert(id == 2800)
                return progression
            end,
            GetTotalReputationForRenownLevel = function(_, level)
                return totals[level] or 9000
            end,
            GetRenownRewardsForLevel = function(_, level)
                return level == 4 and { { description = "Necklace" } } or {}
            end,
        }
        function GetCurrentArenaSeason()
            return 1
        end
        C_SeasonInfo = {
            GetTimeUntilCurrentPVPSeasonEnd = function()
                return 0
            end,
        }
        C_CurrencyInfo = {
            GetCurrencyInfo = function(id)
                assert(id == 1792)
                return {
                    name = "Honor Points",
                    quantity = 89,
                    maxQuantity = 25000,
                    quantityEarnedThisWeek = 89,
                    maxWeeklyQuantity = 0,
                }
            end,
        }
        function GetPVPSessionStats()
            return 3, 0
        end
        function GetPVPLifetimeStats()
            return 15, 0
        end
    end
    helper.addon("Character/Capture.lua", env)
end

it("the pvp section reads Forever's rank track, honor currency and kills", function()
    local env = helper.env()
    setfenv(1, env)
    setupPvp(env)

    local pvp = ns.Character.Capture({ "pvp" }).sections.pvp
    assert(pvp.status == "available")
    local rank, honor = pvp.data.rank, pvp.data.honor
    assert(rank.rank == 2 and rank.title == "Grunt" and rank.points == 40)
    assert(rank.nextRankPoints == 200 and rank.seasonPoints == 290 and rank.maxRank == 14)
    assert(rank.weeklyCapRank == 3 and rank.weeklyCapPoints == 450)
    assert(rank.weeklyCapIncrease == 350 and rank.seasonMaxPoints == 9000)
    assert(rank.nextReward.rank == 4 and rank.nextReward.rewards[1] == "Necklace")
    assert(pvp.data.season.number == 1 and pvp.data.season.endsInSeconds == nil)
    assert(honor.amount == 89 and honor.max == 25000 and honor.earnedThisWeek == 89)
    assert(honor.weeklyMax == nil, "no weekly honor cap is not a cap of zero")
    assert(pvp.data.kills.today.honorable == 3 and pvp.data.kills.lifetime == 15)
    assert(pvp.data.kills.yesterday == nil, "a missing API stays unknown")

    progression.renownLevel = 0
    assert(ns.Character.Capture({ "pvp" }).sections.pvp.data.rank.title == "Civilian")
    C_MajorFactions = nil
    local unranked = ns.Character.Capture({ "pvp" }).sections.pvp.data
    assert(unranked.rank == nil and unranked.honor.amount == 89)
    C_CurrencyInfo, GetPVPLifetimeStats = nil, nil
    assert(ns.Character.Capture({ "pvp" }).sections.pvp.status == "unavailable")
end)

it("known spells are returned and missing talent APIs stay unknown, never zero", function()
    local env = helper.env()
    setfenv(1, env)
    setupFrame(env)
    do
        ns = helper.namespace()
        function UnitName()
            return "Testmage"
        end
        function time()
            return 123
        end
        Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1 } }
        C_SpellBook = {
            GetNumSpellBookSkillLines = function()
                return 1
            end,
            GetSpellBookSkillLineInfo = function()
                return { itemIndexOffset = 0, numSpellBookItems = 1 }
            end,
            GetSpellBookItemInfo = function()
                return { spellID = 122, name = "Frost Nova", itemType = 1, subName = "Rank 1" }
            end,
        }
    end
    helper.addon("Character/Capture.lua", env)
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Actions/Game.lua", env)

    local s = ns.Character.Capture({ "spells", "talents" })
    assert(s.sections.spells.data.known[1].id == 122)
    assert(s.sections.spells.data.known[1].name == "Frost Nova")
    assert(s.sections.talents.status == "unavailable")
    assert(s.sections.talents.data == nil)
end)

it("an older bridge snapshot cannot erase an optimistic message", function()
    local env = helper.env()
    setfenv(1, env)
    setupSnapshot(env)

    ns.db = { drafts = {} }
    ns.UI.Refresh = function() end
    ns.Transport.Send = function(p)
        SENT = p
    end
    ns.Transport.Acknowledge = function() end
    ns.active = "chat"
    ns.chats = { { id = "chat", title = "test", status = "idle", messages = {} } }
    ns.draft = {
        GetText = function()
            return "hello"
        end,
        SetText = function() end,
    }
    ns.Chat.Submit()
    local id = SENT.messageId
    assert(ns.Chat.Current().messages[1].text == "hello")
    SNAPSHOT = {
        v = 1,
        session = ns.session,
        rev = 1,
        chats = {
            { id = "chat", title = "test", status = "idle", messages = {} },
        },
    }
    WispAI_Receive("")
    assert(ns.Chat.Current().messages[1].text == "hello")
    assert(ns.pendingMessages[id])
    SNAPSHOT = {
        v = 1,
        session = ns.session,
        rev = 2,
        chats = {
            {
                id = "chat",
                title = "test",
                status = "working",
                messages = {
                    { id = id, role = "user", text = "hello" },
                },
            },
        },
    }
    WispAI_Receive("")
    assert(#ns.Chat.Current().messages == 1)
    assert(ns.pendingMessages[id] == nil)
end)

it("each sent message captures only character and location automatically", function()
    local env = helper.env()
    setfenv(1, env)
    setupFrame(env)
    do
        ns = helper.namespace()
        function time()
            return 123
        end
        function GetTime()
            return 5
        end
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        SlashCmdList = {}
    end
    helper.addon("Core.lua", env)

    ns.db = { drafts = {} }
    ns.UI.Refresh = function() end
    ns.active = "chat"
    ns.chats = { { id = "chat", title = "test", status = "idle", messages = {} } }
    ns.draft = {
        GetText = function()
            return "hello"
        end,
        SetText = function() end,
    }
    local captures = 0
    ns.Character.Capture = function(sections)
        captures = captures + 1
        assert(#sections == 2 and sections[1] == "character" and sections[2] == "location")
        return { capturedAt = captures }
    end
    ns.Transport.Send = function(packet)
        SENT = packet
    end
    ns.Chat.Submit()
    assert(captures == 1 and SENT.context.capturedAt == 1)
    ns.Chat.Current().status = "done"
    ns.Chat.Submit()
    assert(captures == 2 and SENT.context.capturedAt == 2, "a new turn must carry a new snapshot")
end)

it("deleted conversations stay removed when an older snapshot arrives", function()
    local env = helper.env()
    setfenv(1, env)
    setupSnapshot(env)

    ns.db = { drafts = { a = "draft" } }
    ns.UI.Refresh = function() end
    ns.Transport.Send = function(p)
        SENT = p
    end
    ns.Transport.Acknowledge = function() end
    ns.active = "a"
    ns.chats = {
        { id = "a", messages = {}, status = "idle" },
        { id = "b", messages = {}, status = "idle" },
    }
    ns.Chat.DeleteChat("a")
    assert(ns.active == "b")
    assert(ns.db.drafts.a == nil)
    assert(SENT.type == "delete" and SENT.chat == "a" and SENT.nextChat == "b")
    SNAPSHOT = {
        v = 1,
        session = ns.session,
        rev = 1,
        activeChat = "a",
        chats = {
            { id = "a", messages = {} },
            { id = "b", messages = {} },
        },
    }
    WispAI_Receive("")
    assert(#ns.chats == 1 and ns.chats[1].id == "b")
    assert(ns.active == "b")
end)

it(
    "capability toggles preserve their pending state until the matching bridge acknowledgement",
    function()
        local env = helper.env()
        setfenv(1, env)
        setupCore(env)

        ns.db = { drafts = {} }
        ns.Transport.Send = function(packet)
            SENT = packet
        end
        ns.Transport.Acknowledge = function() end
        ns.Chat.SetCapability("tool:inspect_target", false)
        local id = SENT.requestId
        assert(SENT.type == "capability_set" and SENT.enabled == false)
        SNAPSHOT = {
            v = 1,
            session = ns.session,
            rev = 1,
            capabilities = {
                entries = { { id = "tool:inspect_target", enabled = true } },
                acks = {},
            },
        }
        WispAI_Receive("")
        assert(
            ns.capabilityPending["tool:inspect_target"].enabled == false,
            "a stale authoritative checkbox must not undo a pending toggle"
        )
        SNAPSHOT = {
            v = 1,
            session = ns.session,
            rev = 2,
            capabilities = {
                entries = { { id = "tool:inspect_target", enabled = false } },
                acks = { ["tool:inspect_target"] = id },
            },
        }
        WispAI_Receive("")
        assert(
            ns.capabilityPending["tool:inspect_target"] == nil
                and ns.capabilities[1].enabled == false
        )
        ns.Chat.SetCapability("tool:inspect_target", true)
        SNAPSHOT = {
            v = 1,
            session = ns.session,
            rev = 3,
            capabilities = {
                entries = { { id = "tool:inspect_target", enabled = false } },
                error = { requestId = SENT.requestId, message = "Save failed" },
            },
        }
        WispAI_Receive("")
        assert(
            ns.capabilityPending["tool:inspect_target"] == nil
                and ns.capabilityError == "Save failed"
        )
    end
)

it(
    "repeated action delivery executes once and returns its result through the reliable outbox",
    function()
        local env = helper.env()
        setfenv(1, env)
        setupCore(env)

        ns.db = { drafts = {} }
        ns.Transport.Send = function(packet)
            SENT = packet
        end
        ns.Transport.Acknowledge = function() end
        local calls = 0
        ns.Actions.PerformAction = function(action)
            calls = calls + 1
            return { status = "completed" }
        end
        SNAPSHOT = {
            v = 1,
            session = ns.session,
            rev = 1,
            requests = {
                { id = "action-1", chat = "chat", action = { kind = "create_macro", args = {} } },
            },
        }
        WispAI_Receive("")
        assert(calls == 1 and SENT.type == "state_result" and SENT.data.status == "completed")
        SNAPSHOT.rev = 2
        WispAI_Receive("")
        assert(calls == 1, "transport replay must never repeat a mutation")
        ns.Actions.PerformAction = function()
            calls = calls + 1
            error("provider failed")
        end
        SNAPSHOT.rev = 3
        SNAPSHOT.requests[1].id = "action-2"
        WispAI_Receive("")
        assert(calls == 2 and SENT.requestId == "action-2")
        assert(
            SENT.data.status == "unavailable" and SENT.data.error:find("provider failed", 1, true)
        )
        SNAPSHOT.rev = 4
        WispAI_Receive("")
        assert(calls == 2, "failed actions must report errors without executing again")
    end
)
