local helper = require("addon.tests.support")
local luassert = assert

-- Loads Moments with the UI stub. Timers run when `flush` is called, so a
-- test can fire an event and then let the deferred handler run.
local function setup(flagOn)
    local env = helper.env()
    env.assert = luassert
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    do
        ns = helper.namespace({ db = {}, connected = true, chats = {} })
        timers, submitted = {}, {}
        combat = false
        flags = { ask_wisp_moments = true }
        featureListeners = {}
        ns.Core.FeatureEnabled = function(name)
            return flags[name] == true
        end
        ns.Core.OnFeaturesChanged = function(listener)
            featureListeners[#featureListeners + 1] = listener
        end
        function setFlag(value)
            flags.ask_wisp_moments = value
            for _, listener in ipairs(featureListeners) do
                listener()
            end
        end
        -- Frames remember which events they listen to, as in the game.
        local create = CreateFrame
        CreateFrame = function(...)
            local frame = create(...)
            frame.registered = {}
            frame.RegisterEvent = function(self, event)
                self.registered[event] = true
            end
            frame.UnregisterEvent = function(self, event)
                self.registered[event] = nil
            end
            return frame
        end
        C_Timer.After = function(seconds, fn)
            timers[#timers + 1] = { seconds = seconds, fn = fn }
        end
        function flush(maxSeconds)
            local pending = timers
            timers = {}
            for _, timer in ipairs(pending) do
                if timer.seconds <= (maxSeconds or 0) then
                    timer.fn()
                else
                    timers[#timers + 1] = timer
                end
            end
        end
        InCombatLockdown = function()
            return combat
        end
        UnitGUID = function()
            return "Player-1"
        end
        ns.Chat.AskNew = function(prompt)
            submitted[#submitted + 1] = prompt
        end
        ns.UI.SetMinimized = function(value)
            minimized = value
        end
        ns.UI.Widgets = {
            COLORS = { window = {}, line = {}, secondary = {}, text = {} },
            FONTS = {},
            TEXTURES = "",
            Box = function() end,
            Hover = function() end,
            Caption = function(parent)
                return parent:CreateFontString()
            end,
            Label = function(parent)
                return parent:CreateFontString()
            end,
        }
    end
    helper.addon("Locale.lua", env)
    helper.addon("Locales/enUS.lua", env)
    helper.addon("Moments/Moments.lua", env)
    if flagOn == false then
        flags.ask_wisp_moments = false
    end
    ns.Moments.InitMoments()
    local events
    for _, w in ipairs(UI_TEST.widgets) do
        if w.scripts.OnEvent then
            events = w
        end
    end
    env.events = events
    env.fire = function(event, ...)
        if events.registered[event] then
            events.scripts.OnEvent(events, event, ...)
        end
        env.flush(0)
    end
    return env, ns.Moments._Card()
end

describe("moments", function()
    it("offers why the player died after the recap is recorded and asks in a new chat", function()
        local env, card = setup()
        setfenv(1, env)
        card:Hide()
        fire("PLAYER_DEAD")
        assert.is_false(card:IsShown())
        flush(2)
        assert.is_true(card:IsShown())
        assert.equal("Why did I just die?", card.body:GetText())
        card.scripts.OnClick(card)
        assert.same({ "Why did I just die?" }, submitted)
        assert.is_false(minimized)
        assert.is_false(card:IsShown())
    end)

    it("fills placeholders, respects cooldowns and the setting", function()
        local env, card = setup()
        setfenv(1, env)
        UI_TEST.now = 100
        fire("PLAYER_LEVEL_UP", 12)
        assert.equal(
            "I just reached level 12. What's new for me and where should I go next?",
            card.body:GetText()
        )
        card.close.scripts.OnClick(card.close)
        UI_TEST.now = 130
        fire("ENCOUNTER_END", 1, "Hogger", 1, 5, 0)
        assert.equal(
            "We just wiped on Hogger. What went wrong and what should we change?",
            card.body:GetText()
        )
        card:Hide()
        UI_TEST.now = 150
        fire("ENCOUNTER_END", 1, "Hogger", 1, 5, 0)
        assert.is_false(card:IsShown(), "a wipe within its cooldown is not offered again")
        fire("ENCOUNTER_END", 2, "Van Cleef", 1, 5, 1)
        assert.is_false(card:IsShown(), "a kill is not a wipe")
        UI_TEST.now = 200
        fire("PLAYER_LEVEL_UP", 13)
        assert.is_true(card:IsShown())
        setFlag(false)
        assert.is_false(card:IsShown(), "turning the flag off hides the card")
        assert.is_nil(events.registered.PLAYER_LEVEL_UP, "and stops listening")
        fire("PLAYER_LEVEL_UP", 14)
        assert.is_false(card:IsShown())
    end)

    it("listens to the game only once the feature flag turns on", function()
        local env, card = setup(false)
        setfenv(1, env)
        assert.is_nil(next(events.registered), "flags are off until the bridge answers")
        fire("PLAYER_LEVEL_UP", 5)
        assert.is_false(card:IsShown())
        setFlag(true)
        fire("PLAYER_LEVEL_UP", 6)
        assert.is_true(card:IsShown())
    end)

    it("waits for combat to end before showing a moment", function()
        local env, card = setup()
        setfenv(1, env)
        card:Hide()
        combat = true
        fire("PLAYER_LEVEL_UP", 20)
        assert.is_false(card:IsShown())
        combat = false
        fire("PLAYER_REGEN_ENABLED")
        assert.is_true(card:IsShown())
    end)

    it("pins to an open game window and hides with it", function()
        local env, card = setup()
        setfenv(1, env)
        card:Hide()
        local hooks = {}
        AuctionHouseFrame = CreateFrame("Frame", "AuctionHouseFrame")
        AuctionHouseFrame.HookScript = function(self, name, fn)
            hooks[name] = function()
                fn(self)
            end
        end
        fire("AUCTION_HOUSE_SHOW")
        assert.is_true(card:IsShown())
        assert.equal(AuctionHouseFrame, card.anchor)
        assert.is_nil(timers[1], "a pinned card does not time out")
        AuctionHouseFrame:Hide()
        hooks.OnHide()
        assert.is_false(card:IsShown())
    end)

    it("offers a vendor question only when bags are nearly full", function()
        local env, card = setup()
        setfenv(1, env)
        local free = 20
        -- Like the game, the call also returns the bag family (0 for a backpack).
        C_Container = {
            GetContainerNumFreeSlots = function(bag)
                return bag == 0 and free or 0, 0
            end,
        }
        fire("MERCHANT_SHOW")
        assert.is_false(card:IsShown())
        free = 3
        fire("MERCHANT_SHOW")
        assert.equal(
            "My bags are nearly full and I'm at a vendor. What should I sell?",
            card.body:GetText()
        )
    end)

    it("offers looted gear only when it beats what is equipped", function()
        local env, card = setup()
        setfenv(1, env)
        card:Hide()
        local levels = { ["new-helm"] = 30, ["old-helm"] = 25, ["old-ring"] = 40 }
        C_Item.GetItemInfo = function(link)
            if link:find("Helm") then
                return "Shiny Helm", link, 3, 30, 1, "Armor", "Plate", 1, "INVTYPE_HEAD"
            end
            return "Rusty Ring", link, 2, 30, 1, "Armor", "Misc", 1, "INVTYPE_FINGER"
        end
        C_Item.GetDetailedItemLevelInfo = function(link)
            return levels[link] or (link:find("Helm") and 30) or 30
        end
        GetInventoryItemLink = function(_, slot)
            return slot == 1 and "old-helm" or "old-ring"
        end
        local ring = "You receive loot: |cff1eff00|Hitem:2:0|h[Rusty Ring]|h|r."
        fire("CHAT_MSG_LOOT", ring, "", "", "", "", "", 0, 0, "", 0, 1, "Player-1")
        assert.is_false(card:IsShown(), "both ring slots hold a higher item level")
        local helm = "You receive loot: |cff0070dd|Hitem:1:0|h[Shiny Helm]|h|r."
        fire("CHAT_MSG_LOOT", helm, "", "", "", "", "", 0, 0, "", 0, 1, "Other-2")
        assert.is_false(card:IsShown(), "someone else's loot is ignored")
        fire("CHAT_MSG_LOOT", helm, "", "", "", "", "", 0, 0, "", 0, 1, "Player-1")
        assert.equal("I just looted Shiny Helm. Is it an upgrade for me?", card.body:GetText())
    end)

    it("offers each dungeon once and skips world quests", function()
        local env, card = setup()
        setfenv(1, env)
        card:Hide()
        IsInInstance = function()
            return true, "party"
        end
        GetInstanceInfo = function()
            return "The Deadmines"
        end
        fire("PLAYER_ENTERING_WORLD")
        assert.equal(
            "I just entered The Deadmines. What should I know before we start?",
            card.body:GetText()
        )
        card:Hide()
        fire("ZONE_CHANGED_NEW_AREA")
        assert.is_false(card:IsShown())
        C_QuestLog = {
            IsWorldQuest = function(id)
                return id == 2
            end,
            IsQuestTask = function()
                return false
            end,
            GetTitleForQuestID = function(id)
                return id == 1 and "The Defias Brotherhood" or "World Quest"
            end,
        }
        fire("QUEST_ACCEPTED", 2)
        assert.is_false(card:IsShown())
        fire("QUEST_ACCEPTED", 1)
        assert.equal('How do I complete the quest "The Defias Brotherhood"?', card.body:GetText())
    end)
end)
