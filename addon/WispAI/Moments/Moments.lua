local _, ns = ...
local L = ns.L

-- Moments: when the player does something Wisp can help with (dies, opens the
-- auction house, levels up...), a small card offers a one-click question. Nothing
-- reaches the bridge until the player clicks it, so showing a card costs no
-- model call. Clicking starts a new conversation with the question.
local CARD_WIDTH, PAD = 280, 10
-- An unanchored card hides on its own after this many seconds. A card pinned
-- to a game window (auction house, vendor, trainer) stays while it is open.
local SHOW_SECONDS = 20
-- A moment that happens in combat waits for combat to end, for this long.
local DEFER_SECONDS = 30
-- The death card waits for the Death Recap to be recorded (Combat.lua).
local DEATH_DELAY = 2
-- A vendor card appears only when bags are this close to full.
local MERCHANT_FREE_SLOTS = 8

---@class Moment
---@field prompt string Locale key of the question; `{name}` placeholders come from values.
---@field cooldown number Seconds before the same moment can show again.
---@field frames? string[] Game windows the card pins to, first shown wins.

---@type table<string, Moment>
local MOMENTS = {
    death = { prompt = "moment.death", cooldown = 60 },
    wipe = { prompt = "moment.wipe", cooldown = 60 },
    auction = {
        prompt = "moment.auction",
        cooldown = 300,
        frames = { "AuctionHouseFrame", "AuctionFrame" },
    },
    merchant = { prompt = "moment.merchant", cooldown = 600, frames = { "MerchantFrame" } },
    trainer = { prompt = "moment.trainer", cooldown = 300, frames = { "ClassTrainerFrame" } },
    levelUp = { prompt = "moment.levelUp", cooldown = 0 },
    loot = { prompt = "moment.loot", cooldown = 120 },
    instance = { prompt = "moment.instance", cooldown = 0 },
    quest = { prompt = "moment.quest", cooldown = 300 },
}

-- Inventory slots an equippable item can go in, by its equip location.
local SLOTS = {
    INVTYPE_HEAD = { 1 },
    INVTYPE_NECK = { 2 },
    INVTYPE_SHOULDER = { 3 },
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
    INVTYPE_RANGED = { 16, 18 },
    INVTYPE_RANGEDRIGHT = { 16, 18 },
    INVTYPE_WEAPONOFFHAND = { 17 },
    INVTYPE_SHIELD = { 17 },
    INVTYPE_HOLDABLE = { 17 },
}

local card, events
local listening = false
local lastShown = {}
local seenInstances = {}
local deferred
local showToken = 0
local hooked = {}

local function readable(value)
    return value ~= nil and not (issecretvalue and issecretvalue(value))
end

local function results(ok, ...)
    if ok then
        return ...
    end
end

-- Calls an optional game API, returning all its results or nothing on error.
local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    return results(pcall(fn, ...))
end

local function inCombat()
    return (InCombatLockdown and InCombatLockdown() == true)
        or (UnitAffectingCombat and UnitAffectingCombat("player") == true)
        or false
end

-- Behind a feature flag while the moments are tried out.
local FEATURE = "ask_wisp_moments"

local function enabled()
    return ns.Core.FeatureEnabled(FEATURE) and ns.connected and not ns.Transport.needsDesktopSetup
end

-- The first of the moment's game windows that is open, if any.
local function openFrame(moment)
    for _, name in ipairs(moment.frames or {}) do
        local frame = _G[name]
        if frame and frame.IsShown and frame:IsShown() then
            return frame
        end
    end
end

local function hide()
    showToken = showToken + 1
    if card then
        card.moment, card.anchor = nil, nil
        card:Hide()
    end
end

local function ask()
    local question = card.question
    hide()
    if not question then
        return
    end
    ns.UI.SetMinimized(false)
    ns.Chat.AskNew(question)
end

local function place(moment)
    card:ClearAllPoints()
    local frame = openFrame(moment)
    if frame then
        card.anchor = frame
        card:SetPoint("TOPLEFT", frame, "TOPRIGHT", 8, 0)
        if not hooked[frame] and frame.HookScript then
            hooked[frame] = true
            frame:HookScript("OnHide", function(self)
                if card.anchor == self then
                    hide()
                end
            end)
        end
        return true
    end
    local dialog = moment == MOMENTS.death
        and StaticPopup_FindVisible
        and call(StaticPopup_FindVisible, "DEATH")
    if dialog then
        card:SetPoint("TOP", dialog, "BOTTOM", 0, -8)
    else
        card:SetPoint("TOP", UIParent, "TOP", 0, -200)
    end
    return false
end

local function show(key, values)
    local moment = MOMENTS[key]
    card.moment = key
    card.question = ns.LocaleText(moment.prompt, values or {})
    card.body:SetText((card.question:gsub("|", "||")))
    card:SetHeight(math.floor(34 + (card.body:GetStringHeight() or 0) + PAD + 0.5))
    lastShown[key] = GetTime()
    local pinned = place(moment)
    card:Show()
    showToken = showToken + 1
    if not pinned and C_Timer and C_Timer.After then
        local token = showToken
        C_Timer.After(SHOW_SECONDS, function()
            if token == showToken then
                hide()
            end
        end)
    end
end

--- Offers a moment's question unless moments are off, it showed recently, or
--- a moment pinned to an open game window is already showing. In combat it
--- waits for combat to end.
---@param key string A key of MOMENTS.
---@param values? table Values for the question's `{name}` placeholders.
function ns.Moments.Offer(key, values)
    local moment = MOMENTS[key]
    if not moment or not card or not enabled() then
        return
    end
    local last = lastShown[key]
    if last and GetTime() - last < moment.cooldown then
        return
    end
    if card.moment and card.anchor and card.anchor:IsShown() and card.moment ~= key then
        return
    end
    if inCombat() then
        deferred = { key = key, values = values, at = GetTime() }
        return
    end
    show(key, values)
end

local function bagsNearlyFull()
    if not C_Container or not C_Container.GetContainerNumFreeSlots then
        return false
    end
    local free = 0
    for bag = 0, 4 do
        -- The call also returns the bag family; keep only the count.
        local slots = call(C_Container.GetContainerNumFreeSlots, bag)
        free = free + (tonumber(slots) or 0)
    end
    return free <= MERCHANT_FREE_SLOTS
end

local function itemLevel(link)
    local level = C_Item and call(C_Item.GetDetailedItemLevelInfo, link)
    if not level and GetDetailedItemLevelInfo then
        level = call(GetDetailedItemLevelInfo, link)
    end
    return tonumber(level)
end

-- An uncommon or better item the player could equip in a slot that is empty
-- or holds a lower item level.
local function lootUpgrade(link)
    local getInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
    local name, _, quality, _, _, _, _, _, equipLoc = call(getInfo, link)
    local slots = equipLoc and SLOTS[equipLoc]
    if not name or not slots or (tonumber(quality) or 0) < 2 then
        return nil
    end
    local looted = itemLevel(link)
    if not looted then
        return nil
    end
    for _, slot in ipairs(slots) do
        local equipped = GetInventoryItemLink and call(GetInventoryItemLink, "player", slot)
        if not equipped or (itemLevel(equipped) or 0) < looted then
            return name
        end
    end
end

local function onLoot(text, guid)
    if not readable(text) or not readable(guid) or type(text) ~= "string" then
        return
    end
    if not UnitGUID or guid ~= UnitGUID("player") then
        return
    end
    local link = text:match("|c%x+|Hitem:.-|h%[.-%]|h|r") or text:match("|Hitem:.-|h%[.-%]|h")
    local name = link and lootUpgrade(link)
    if name then
        ns.Moments.Offer("loot", { item = name })
    end
end

local function onInstance()
    local inside, kind = call(IsInInstance)
    if not inside or (kind ~= "party" and kind ~= "raid") then
        return
    end
    local name = call(GetInstanceInfo)
    if not readable(name) or name == "" or seenInstances[name] then
        return
    end
    seenInstances[name] = true
    ns.Moments.Offer("instance", { name = name })
end

local function onQuest(questId)
    local log = C_QuestLog
    questId = tonumber(questId)
    if not log or not questId then
        return
    end
    if call(log.IsWorldQuest, questId) or call(log.IsQuestTask, questId) then
        return
    end
    local title = call(log.GetTitleForQuestID, questId)
    if readable(title) and title ~= "" then
        ns.Moments.Offer("quest", { quest = title })
    end
end

local HANDLERS = {
    PLAYER_DEAD = function()
        if C_Timer and C_Timer.After then
            C_Timer.After(DEATH_DELAY, function()
                ns.Moments.Offer("death")
            end)
        else
            ns.Moments.Offer("death")
        end
    end,
    ENCOUNTER_END = function(_, name, _, _, success)
        if readable(success) and success == 0 and readable(name) and name ~= "" then
            ns.Moments.Offer("wipe", { boss = name })
        end
    end,
    AUCTION_HOUSE_SHOW = function()
        ns.Moments.Offer("auction")
    end,
    MERCHANT_SHOW = function()
        if bagsNearlyFull() then
            ns.Moments.Offer("merchant")
        end
    end,
    TRAINER_SHOW = function()
        ns.Moments.Offer("trainer")
    end,
    PLAYER_LEVEL_UP = function(level)
        ns.Moments.Offer("levelUp", { level = tonumber(level) or level })
    end,
    CHAT_MSG_LOOT = function(...)
        onLoot(select(1, ...), select(12, ...))
    end,
    PLAYER_ENTERING_WORLD = onInstance,
    ZONE_CHANGED_NEW_AREA = onInstance,
    QUEST_ACCEPTED = function(first, second)
        -- Older clients pass the log index first and the quest ID second.
        onQuest(second or first)
    end,
    PLAYER_REGEN_ENABLED = function()
        local pending = deferred
        deferred = nil
        if pending and GetTime() - pending.at <= DEFER_SECONDS then
            ns.Moments.Offer(pending.key, pending.values)
        end
    end,
}

-- Game windows open a frame after their event; place the card once they show.
local function dispatch(_, event, ...)
    local handler = HANDLERS[event]
    if not handler then
        return
    end
    local args = { n = select("#", ...), ... }
    if C_Timer and C_Timer.After then
        C_Timer.After(0, function()
            handler(unpack(args, 1, args.n))
        end)
    else
        handler(...)
    end
end

local function buildCard()
    local widgets = ns.UI.Widgets
    local COLORS = widgets.COLORS
    card = CreateFrame("Button", "WispAIMoment", UIParent)
    card:SetSize(CARD_WIDTH, 60)
    card:SetFrameStrata("DIALOG")
    card:SetClampedToScreen(true)
    card:EnableMouse(true)
    card:RegisterForClicks("LeftButtonUp")
    widgets.Box(card, COLORS.window, COLORS.line)
    widgets.Hover(card, 0.06)
    local mark = card:CreateTexture(nil, "ARTWORK")
    mark:SetTexture(widgets.TEXTURES .. "Wisp.tga")
    mark:SetSize(14, 14)
    mark:SetPoint("TOPLEFT", PAD, -10)
    local close = CreateFrame("Button", "WispAIMomentClose", card)
    close:SetSize(18, 18)
    close:SetPoint("TOPRIGHT", -6, -8)
    close.icon = close:CreateTexture(nil, "ARTWORK")
    close.icon:SetTexture(widgets.TEXTURES .. "Close.tga")
    close.icon:SetSize(9, 9)
    close.icon:SetPoint("CENTER")
    close.icon:SetVertexColor(unpack(COLORS.secondary))
    widgets.Hover(close, 0.08)
    close:SetScript("OnClick", hide)
    close:SetScript("OnEnter", function(self)
        self.icon:SetVertexColor(unpack(COLORS.text))
    end)
    close:SetScript("OnLeave", function(self)
        self.icon:SetVertexColor(unpack(COLORS.secondary))
    end)
    card.close = close
    card.heading = widgets.Caption(card, L["moment.ask"])
    card.heading:SetPoint("LEFT", mark, "RIGHT", 6, 0)
    card.heading:SetPoint("RIGHT", close, "LEFT", -6, 0)
    card.heading:SetWordWrap(false)
    card.body = widgets.Label(card, "", COLORS.text, widgets.FONTS.body)
    card.body:SetPoint("TOPLEFT", PAD, -34)
    card.body:SetWidth(CARD_WIDTH - PAD * 2)
    card.body:SetWordWrap(true)
    card.body:SetMaxLines(3)
    card:SetScript("OnClick", ask)
    card:Hide()
end

-- Listens to the game only while the flag is on. Flags are off until the
-- bridge's first snapshot, so this runs again whenever they change.
local function sync()
    local on = ns.Core.FeatureEnabled(FEATURE)
    if on == listening then
        return
    end
    listening = on
    for event in pairs(HANDLERS) do
        if on then
            pcall(events.RegisterEvent, events, event)
        else
            events:UnregisterEvent(event)
        end
    end
    if not on then
        deferred = nil
        hide()
    end
end

function ns.Moments.InitMoments()
    buildCard()
    events = CreateFrame("Frame")
    events:SetScript("OnEvent", dispatch)
    ns.Core.OnFeaturesChanged(sync)
    sync()
end

--- The card frame, for tests.
function ns.Moments._Card()
    return card
end
