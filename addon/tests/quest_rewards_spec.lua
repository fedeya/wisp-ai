local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    env.ns = helper.namespace()
    local callback, shown, quest = nil, true, 42
    env.CreateFrame = function()
        return {
            RegisterEvent = function() end,
            SetScript = function(_, _, fn)
                callback = fn
            end,
        }
    end
    env.time = function()
        return 123
    end
    env.UnitName = function()
        return "Mage"
    end
    env.QuestFrameRewardPanel = {
        IsVisible = function()
            return shown
        end,
    }
    env.GetQuestID = function()
        return quest
    end
    env.GetTitleText = function()
        return "Reward quest"
    end
    env.GetNumQuestChoices = function()
        return 3
    end
    env.GetNumQuestRewards = function()
        return 1
    end
    env.GetQuestItemInfoLootType = function()
        return 0
    end
    env.GetQuestItemInfo = function(kind, index)
        return kind .. index, nil, index + 1, 2, true, 100
    end
    env.GetQuestItemLink = function(kind, index)
        return "item:100:" .. kind .. index
    end
    env.C_Item = {
        GetItemInfo = function(link)
            return "Exact", link, 2, 20, 10, "Armor", "Cloth", 1, "INVTYPE_FINGER"
        end,
        GetItemStats = function(link)
            return { INT = link:find("choice1") and 4 or 2 }
        end,
    }
    env.GetInventoryItemLink = function(_, slot)
        return "item:200:variant" .. slot
    end
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Character/QuestRewards.lua", env)
    local function event(name)
        callback(nil, name)
    end
    event("QUEST_COMPLETE")
    return env,
        event,
        function(value)
            quest = value
        end,
        function(value)
            shown = value
        end
end

for position = 10, 18 do
    for _, payload in ipairs({ "populated", "zero", "false", "secret" }) do
        it(
            "rejects " .. payload .. " item-info tail at position " .. position .. " in one call",
            function()
                local env = setup()
                local cached, calls = env.C_Item.GetItemInfo, 0
                local secret = {}
                env.issecretvalue = function(value)
                    return rawequal(value, secret)
                end
                env.C_Item.GetItemInfo = function(link)
                    if not link:find("choice1") then
                        return cached(link)
                    end
                    calls = calls + 1
                    local values = {}
                    if payload == "populated" then
                        values[position] = 123
                    elseif payload == "zero" then
                        values[position] = 0
                    elseif payload == "false" then
                        values[position] = false
                    else
                        values[position] = secret
                    end
                    return unpack(values, 1, 18)
                end
                env.C_Item.RequestLoadItemDataByID = function()
                    error("no item loads allowed")
                end
                local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
                assert.equals(1, calls)
                assert.equals("available", result.status)
                local item = result.data.choices.options[1]
                assert.equals("unknown", item.status)
                assert.equals(
                    payload == "secret" and "restricted" or "invalid_response",
                    item.reason
                )
                assert.is_nil(item.stats)
                assert.equals("item:100:choice1", item.link)
                assert.equals(2, item.quantity)
                assert.equals(100, item.id)
                assert.equals("available", result.data.choices.options[2].status)
                assert.equals("available", result.data.guaranteed.options[1].status)
                assert.is_false(result.data.truncated)
                assert.is_nil(result.error)
            end
        )
    end
end

for _, arity in ipairs({ 0, 1, 9, 18 }) do
    it(
        "keeps a successful empty item-info tuple of arity " .. arity .. " loading in one call",
        function()
            local env = setup()
            local cached, calls = env.C_Item.GetItemInfo, 0
            env.C_Item.GetItemInfo = function(link)
                if not link:find("choice1") then
                    return cached(link)
                end
                calls = calls + 1
                return unpack({}, 1, arity)
            end
            local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
            local item = result.data.choices.options[1]
            assert.equals(1, calls)
            assert.equals("loading", item.status)
            assert.equals("uncached", item.reason)
            assert.equals("available", result.data.choices.options[2].statsStatus)
            assert.is_false(result.data.truncated)
        end
    )
end

it("checks a secret last return before comparing it even with an earlier populated tail", function()
    local env = setup()
    local cached, calls = env.C_Item.GetItemInfo, 0
    local secret = {}
    env.issecretvalue = function(value)
        return rawequal(value, secret)
    end
    env.C_Item.GetItemInfo = function(link)
        if not link:find("choice1") then
            return cached(link)
        end
        calls = calls + 1
        local values = { [10] = 0, [18] = secret }
        return unpack(values, 1, 18)
    end
    local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
    assert.equals(1, calls)
    assert.equals("unknown", data.choices.options[1].status)
    assert.equals("restricted", data.choices.options[1].reason)
    assert.equals("available", data.choices.options[2].status)
end)

it(
    "retains exact-link stats and matching slots from a cached eighteen-position response",
    function()
        local env = setup()
        local cached, calls = env.C_Item.GetItemInfo, {}
        env.C_Item.GetItemInfo = function(link)
            calls[link] = (calls[link] or 0) + 1
            local values = { cached(link) }
            values[10], values[18] = 123, false
            return unpack(values, 1, 18)
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        local item = data.choices.options[1]
        assert.equals(1, calls[item.link])
        assert.equals("available", item.status)
        assert.equals("available", item.statsStatus)
        assert.equals(4, item.stats.INT)
        assert.equals("INVTYPE_FINGER", item.equipLocation)
        assert.equals(11, item.comparisons[1].slot)
        assert.equals("item:200:variant12", item.comparisons[2].equipped.link)
        assert.is_false(data.truncated)
    end
)

it(
    "does not interpret a malformed partial item-info tuple as a documented uncached return",
    function()
        local env = setup()
        env.C_Item.GetItemInfo = function()
            return nil, "item:100:partial", 2
        end
        local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
        local item = result.data.choices.options[1]
        assert.equals("unknown", item.status)
        assert.equals("invalid_response", item.reason)
        assert.is_nil(item.stats)
        assert.is_not_true(result.data.truncated)
    end
)

it(
    "labels only successful uncached reads loading and keeps failure reasons bounded with readable siblings",
    function()
        for _, scenario in ipairs({ "uncached", "throw", "secret", "malformed", "empty", "missing" }) do
            local env = setup()
            local cached = env.C_Item.GetItemInfo
            local secret = {}
            env.issecretvalue = function(value)
                return value == secret
            end
            env.C_Item.GetItemInfo = function(link)
                if not link:find("choice1") then
                    return cached(link)
                end
                if scenario == "uncached" then
                    return nil
                end
                if scenario == "throw" then
                    error("private/path/restricted-stack")
                end
                if scenario == "secret" then
                    return secret
                end
                if scenario == "malformed" then
                    return 123
                end
                if scenario == "empty" then
                    return ""
                end
            end
            if scenario == "missing" then
                env.C_Item.GetItemInfo = nil
            end
            env.C_Item.RequestLoadItemDataByID = function()
                error("no load request allowed")
            end
            local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
            assert.equals("available", result.status)
            local item = result.data.choices.options[1]
            assert.equals(scenario == "uncached" and "loading" or "unknown", item.status)
            local reasons = {
                uncached = "uncached",
                throw = "read_failed",
                secret = "restricted",
                malformed = "invalid_response",
                empty = "invalid_response",
                missing = "api_missing",
            }
            assert.equals(reasons[scenario], item.reason)
            assert.is_nil(item.stats)
            assert.is_not_true(item.truncated)
            assert.is_not_true(result.data.truncated)
            assert.is_nil(result.error)
            if scenario ~= "missing" then
                assert.equals("available", result.data.choices.options[2].status)
                assert.equals("item:100:choice2", result.data.choices.options[2].link)
            end
        end
    end
)

it("keeps failed and restricted stats unknown without inventing budget truncation", function()
    for _, scenario in ipairs({ "throw", "secret", "malformed", "missing" }) do
        local env = setup()
        local secret = {}
        env.issecretvalue = function(value)
            return value == secret
        end
        env.C_Item.GetItemStats = function()
            if scenario == "throw" then
                error("private/stat/path")
            end
            if scenario == "secret" then
                return { INT = secret }
            end
            return "invalid"
        end
        if scenario == "missing" then
            env.C_Item.GetItemStats = nil
        end
        local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
        local item = result.data.choices.options[1]
        assert.equals("available", item.status)
        assert.equals("unknown", item.statsStatus)
        assert.is_nil(item.stats)
        local reasons = {
            throw = "read_failed",
            secret = "restricted",
            malformed = "invalid_response",
            missing = "api_missing",
        }
        assert.equals(reasons[scenario], item.statsReason)
        assert.is_not_true(item.statsTruncated)
        assert.is_false(result.data.truncated)
    end
end)

it(
    "retains clipped dialog names on failed item reads and isolates equipped comparison failures",
    function()
        local env = setup()
        local cached = env.C_Item.GetItemInfo
        env.GetQuestItemInfo = function()
            return string.rep("é", 100), nil, 2, 2, true, 100
        end
        env.C_Item.GetItemInfo = function(link)
            if link:find("choice1") or link:find("variant11") then
                error("private item read")
            end
            return cached(link)
        end
        local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
        local choices = result.data.choices
        assert.equals("unknown", choices.options[1].status)
        assert.equals("read_failed", choices.options[1].reason)
        assert.equals(string.rep("é", 80), choices.options[1].name)
        assert.is_true(choices.options[1].nameTruncated)
        assert.is_true(choices.options[1].truncated)
        local sibling = choices.options[2]
        assert.equals("available", sibling.status)
        assert.is_false(sibling.nameTruncated)
        assert.equals("unknown", sibling.comparisons[1].equipped.status)
        assert.equals("read_failed", sibling.comparisons[1].equipped.reason)
        assert.is_false(sibling.comparisons[1].truncated)
        assert.equals("available", sibling.comparisons[2].equipped.status)
        assert.is_false(sibling.truncated)
        assert.is_true(choices.truncated)
        assert.is_true(result.data.truncated)
    end
)

it(
    "discloses ASCII and UTF8 field clipping through items, comparisons and observation coverage",
    function()
        for _, character in ipairs({ "x", "é" }) do
            local env = setup()
            env.GetTitleText = function()
                return string.rep(character, 250)
            end
            env.C_Item.GetItemInfo = function(link)
                local name = link:find("equipped") and "Equipped" or string.rep(character, 200)
                return name, link, 2, 20, 10, "Armor", "Cloth", 1, "INVTYPE_FINGER"
            end
            local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
            local data = result.data
            assert.equals("available", result.status)
            assert.is_true(data.titleTruncated)
            assert.equals(string.rep(character, 200 / #character), data.title)
            assert.is_true(data.truncated)
            assert.is_true(data.choices.truncated)
            assert.is_false(data.choices.optionsTruncated)
            assert.equals(3, #data.choices.options)
            local item = data.choices.options[1]
            assert.equals(string.rep(character, 160 / #character), item.name)
            assert.is_true(item.nameTruncated)
            assert.is_true(item.truncated)
            assert.is_true(item.comparisons[1].equipped.nameTruncated)
            assert.is_true(item.comparisons[1].truncated)
            assert.is_true(item.comparisonsTruncated)
            assert.is_true(data.guaranteed.truncated)
        end
    end
)

it("propagates equipped-only clipping without marking the reward name as clipped", function()
    local env = setup()
    env.C_Item.GetItemInfo = function(link)
        local name = link:find("item:200:") and string.rep("é", 100) or "Reward"
        return name, link, 2, 20, 10, "Armor", "Cloth", 1, "INVTYPE_FINGER"
    end
    local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
    local item = data.choices.options[1]
    assert.is_false(item.nameTruncated)
    assert.is_true(item.comparisons[1].equipped.nameTruncated)
    assert.is_true(item.comparisons[1].truncated)
    assert.is_true(item.truncated)
    assert.is_true(data.choices.truncated)
    assert.is_true(data.truncated)
end)

it(
    "discloses per-item and global stat clipping but keeps unknown availability independent",
    function()
        for _, count in ipairs({ 33, 32 }) do
            local env = setup()
            env.C_Item.GetItemStats = function()
                local stats = {}
                for i = 1, count do
                    stats["stat" .. i] = i
                end
                return stats
            end
            local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
            local item = data.choices.options[count == 33 and 1 or 3]
            assert.equals("available", item.status)
            assert.equals("unknown", item.statsStatus)
            assert.is_nil(item.stats)
            assert.is_true(item.statsTruncated)
            assert.equals(
                count == 33 and "item_stat_limit" or "observation_stat_limit",
                item.statsReason
            )
            assert.is_true(item.truncated)
            assert.is_true(data.choices.truncated)
            assert.is_false(data.choices.optionsTruncated)
            assert.is_true(data.truncated)
            if count == 32 then
                local compared = data.choices.options[2]
                assert.equals("available", compared.statsStatus)
                assert.is_not_true(compared.statsTruncated)
                assert.is_true(compared.comparisons[1].equipped.statsTruncated)
                assert.is_true(compared.comparisons[1].truncated)
                assert.is_true(compared.comparisonsTruncated)
                assert.is_true(compared.truncated)
            end
        end
        local env = setup()
        env.C_Item.GetItemStats = function()
            return nil
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.is_false(data.choices.options[1].truncated)
        assert.is_false(data.choices.truncated)
        assert.is_false(data.truncated)
        assert.is_not_true(data.choices.options[1].statsTruncated)
    end
)

it(
    "renders the observed four rewards in one native table without ranking the guaranteed item",
    function()
        local env = setup()
        local cached = env.C_Item.GetItemInfo
        env.C_Item.GetItemInfo = function(link)
            if not link:find("choice3") then
                return cached(link)
            end
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        -- A local presentation fixture, not an alternate reward reader or model-quality claim.
        local rows = {}
        for _, item in ipairs(data.choices.options) do
            rows[#rows + 1] = {
                "Choice " .. item.index,
                item.link,
                tostring(item.quantity),
                item.stats and tostring(item.stats.INT) or "unknown",
            }
        end
        for _, item in ipairs(data.guaranteed.options) do
            rows[#rows + 1] = {
                "Guaranteed (not ranked)",
                item.link,
                tostring(item.quantity),
                tostring(item.stats.INT),
            }
        end
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        helper.addon("UI/Window.lua", env)
        helper.addon("UI/RichUI.lua", env)
        local host = env.CreateFrame("Frame")
        env.ns.UI.RenderRichUI(host, {}, {
            ui = {
                {
                    id = "quest_rewards",
                    kind = "table",
                    columns = {
                        { label = "Offer" },
                        { label = "Exact variant" },
                        { label = "Quantity" },
                        { label = "INT" },
                    },
                    rows = rows,
                },
            },
        }, 600)
        local rendered = host.widgets.quest_rewards.tableRows
        assert.equals(5, #rendered)
        assert.equals("item:100:choice1", rendered[2].cells[2]:GetText())
        assert.equals("item:100:choice2", rendered[3].cells[2]:GetText())
        assert.equals("unknown", rendered[4].cells[4]:GetText())
        assert.equals("Guaranteed (not ranked)", rendered[5].cells[1]:GetText())
        for index = 2, 5 do
            assert.is_true(rendered[index]:IsShown())
        end
    end
)

it(
    "reads all three exact alternatives and one separate guaranteed reward with exact equipped slots",
    function()
        local env = setup()
        local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
        assert.equals("available", result.status)
        local data = result.data
        assert.equals(3, #data.choices.options)
        assert.equals(1, #data.guaranteed.options)
        assert.equals("item:100:choice1", data.choices.options[1].link)
        assert.equals("item:100:choice2", data.choices.options[2].link)
        assert.equals(2, data.choices.options[1].quantity)
        assert.equals(4, data.choices.options[1].stats.INT)
        assert.equals(11, data.choices.options[1].comparisons[1].slot)
        assert.equals("item:200:variant12", data.choices.options[1].comparisons[2].equipped.link)
        assert.equals(123, data.choices.capturedAt)
    end
)

it(
    "does not call item APIs for secret links and reports missing APIs as unknown, not loading",
    function()
        local env = setup()
        env.C_Item = nil
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals("unknown", data.choices.options[1].status)
        local secret = {}
        env.issecretvalue = function(value)
            return value == secret
        end
        env.GetQuestItemLink = function()
            return secret
        end
        env.C_Item = {
            GetItemInfo = function()
                error("must not inspect secret")
            end,
        }
        data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals("unknown", data.choices.options[1].status)
        assert.is_nil(data.choices.options[1].link)
    end
)

it(
    "bounds counts and UTF8 text, keeps incomplete counts unknown, and never reuses a closed offer",
    function()
        local env, event, _, shown = setup()
        env.GetNumQuestChoices = function()
            return 1000000
        end
        env.GetNumQuestRewards = function()
            return nil
        end
        env.GetTitleText = function()
            return string.rep("é", 150)
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals(10, #data.choices.options)
        assert.is_true(data.choices.truncated)
        assert.equals("unknown", data.guaranteed.status)
        assert.is_nil(data.guaranteed.count)
        assert.equals(string.rep("é", 100), data.title)
        shown(false)
        event("QUEST_FINISHED")
        local closed = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
        assert.equals("unavailable", closed.status)
        assert.is_nil(closed.data)
        shown(true)
        assert.equals(
            "unavailable",
            env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).status
        )
    end
)

it(
    "keeps secret stats and overlong links unknown and never requests loads or performs actions",
    function()
        local env = setup()
        local secret = {}
        env.issecretvalue = function(value)
            return value == secret
        end
        env.C_Item.GetItemStats = function()
            return { INT = secret }
        end
        for _, name in ipairs({
            "AcceptQuest",
            "CompleteQuest",
            "GetQuestReward",
            "SelectQuestReward",
        }) do
            env[name] = function()
                error("read-only violation")
            end
        end
        env.C_Item.RequestLoadItemDataByID = function()
            error("no loading requests")
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals("unknown", data.choices.options[1].statsStatus)
        assert.is_nil(data.choices.options[1].stats)
        env.GetQuestItemLink = function()
            return "item:100:" .. string.rep("x", 600)
        end
        data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals("unknown", data.choices.options[1].status)
        assert.is_nil(data.choices.options[1].link)
    end
)

it(
    "discards the entire offer on quest change, close, or same-quest generation change during a read",
    function()
        for _, mutation in ipairs({ "quest", "close", "generation" }) do
            local env, event, quest, shown = setup()
            env.GetQuestItemLink = function()
                if mutation == "quest" then
                    quest(43)
                elseif mutation == "close" then
                    shown(false)
                else
                    event("QUEST_ITEM_UPDATE")
                end
                return "item:100:old"
            end
            local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
            assert.equals("unavailable", result.status)
            assert.is_nil(result.data)
        end
    end
)

it(
    "keeps loading, unsupported currency and restricted options explicit, never zero stats",
    function()
        local env = setup()
        env.GetQuestItemInfoLootType = function(_, index)
            return index == 2 and 1 or 0
        end
        env.C_Item.GetItemInfo = function()
            return nil
        end
        env.GetQuestItemLink = function(_, index)
            if index ~= 3 then
                return "item:100:uncached"
            end
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals(3, #data.choices.options)
        assert.equals("loading", data.choices.options[1].status)
        assert.equals("unsupported", data.choices.options[2].status)
        assert.equals("currency", data.choices.options[2].kind)
        assert.equals("unknown", data.choices.options[3].status)
        assert.is_nil(data.choices.options[1].stats)
    end
)

it("distinguishes verified zero counts from secret counts and unknown choice loot types", function()
    local env = setup()
    env.GetNumQuestRewards = function()
        return 0
    end
    env.GetQuestItemInfoLootType = nil
    local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
    assert.equals("available", data.guaranteed.status)
    assert.equals(0, data.guaranteed.count)
    assert.equals(0, #data.guaranteed.options)
    assert.equals("unknown", data.choices.options[1].kind)
    assert.equals("unknown", data.choices.options[1].status)
    local secret = {}
    env.issecretvalue = function(value)
        return value == secret
    end
    env.GetNumQuestChoices = function()
        return secret
    end
    data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
    assert.equals("unknown", data.choices.status)
    assert.is_nil(data.choices.count)
    env.GetQuestID = function()
        return secret
    end
    local result = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} })
    assert.equals("unavailable", result.status)
    assert.is_nil(result.data)
end)

it(
    "rejects non-item choices explicitly and bounds per-item and aggregate stats without partial maps",
    function()
        local env = setup()
        env.GetQuestItemInfoLootType = function()
            return 2
        end
        local data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals(3, #data.choices.options)
        assert.equals("unsupported", data.choices.options[1].status)
        assert.equals("unknown", data.choices.options[1].kind)
        env.GetQuestItemInfoLootType = function()
            return 0
        end
        env.C_Item.GetItemStats = function()
            local stats = {}
            for i = 1, 33 do
                stats["stat" .. i] = i
            end
            return stats
        end
        data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.is_nil(data.choices.options[1].stats)
        assert.equals("unknown", data.choices.options[1].statsStatus)
        env.C_Item.GetItemStats = function()
            local stats = {}
            for i = 1, 32 do
                stats["stat" .. i] = i
            end
            return stats
        end
        data = env.ns.Character.Inspect({ kind = "quest_rewards", args = {} }).data
        assert.equals("available", data.choices.options[1].statsStatus)
        assert.equals("unknown", data.choices.options[3].statsStatus)
        assert.is_nil(data.choices.options[3].stats)
    end
)
