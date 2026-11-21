local helper = require("addon.tests.support")

local PLAYER, WOLF, PRIEST = "Player-1", "Creature-1", "Player-2"

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace({ db = {}, chats = {} })
        now = 1000
        health, healthMax = 1000, 1000
        timers = {}
        function time()
            return now
        end
        function UnitName()
            return "Hunter"
        end
        function UnitGUID()
            return PLAYER
        end
        function UnitHealth()
            return health
        end
        function UnitHealthMax()
            return healthMax
        end
        function UnitLevel()
            return 12
        end
        function UnitAffectingCombat()
            return true
        end
        function UnitIsDeadOrGhost()
            return false
        end
        function GetRealZoneText()
            return "Westfall"
        end
        function GetSubZoneText()
            return "Jangolode Mine"
        end
        C_Timer = {
            After = function(_, fn)
                timers[#timers + 1] = fn
            end,
        }
        function CreateFrame()
            return {
                RegisterEvent = function() end,
                SetScript = function(_, _, fn)
                    onEvent = fn
                end,
            }
        end
        -- timestamp, subevent, hideCaster, source GUID/name/flags/raidFlags,
        -- dest GUID/name/flags/raidFlags, then the event's own parameters.
        function log(at, subevent, srcGUID, srcName, dstGUID, dstName, ...)
            current = { at, subevent, false, srcGUID, srcName, 0, 0, dstGUID, dstName, 0, 0, ... }
            combatHandler(nil, "COMBAT_LOG_EVENT_UNFILTERED")
        end
        function CombatLogGetCurrentEventInfo()
            return unpack(current, 1, 30)
        end
        function die()
            combatHandler(nil, "PLAYER_DEAD")
        end
        function flush()
            local pending = timers
            timers = {}
            for _, fn in ipairs(pending) do
                fn()
            end
        end
    end
    helper.addon("CombatLog/CombatLog.lua", env)
    do
        combatHandler = onEvent
    end
    helper.addon("Character/Inspect.lua", env)
end

it("keeps only combat involving the player and parses each event family", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    log(990, "SWING_DAMAGE", WOLF, "Wolf", PRIEST, "Priest")
    log(990, "SPELL_DAMAGE", PLAYER, "Hunter", WOLF, "Wolf")
    log(990, "SPELL_CAST_SUCCESS", WOLF, "Wolf", PLAYER, "Hunter")
    health = 900
    log(991, "SWING_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", 100, -1, 1, 0, 0, 0, true)
    log(992, "SPELL_MISSED", WOLF, "Wolf", PLAYER, "Hunter", 0, "Bite", 1, "DODGE")
    log(993, "SPELL_HEAL", PRIEST, "Priest", PLAYER, "Hunter", 2061, "Lesser Heal", 2, 150, 50)
    log(994, "ENVIRONMENTAL_DAMAGE", nil, nil, PLAYER, "Hunter", "Falling", 80, 0, 1)
    log(995, "SPELL_AURA_APPLIED", WOLF, "Wolf", PLAYER, "Hunter", 0, "Rabies", 8, "DEBUFF")
    log(995, "SPELL_AURA_APPLIED", PLAYER, "Hunter", PLAYER, "Hunter", 0, "Aspect", 1, "BUFF")
    log(996, "SPELL_CAST_SUCCESS", PLAYER, "Hunter", WOLF, "Wolf", 0, "Arcane Shot", 64)

    local result = ns.Character.Inspect({ kind = "combat", args = { view = "recent" } })
    assert(result.status == "available")
    local data = result.data
    assert(data.view == "recent" and data.count == 6 and not data.truncated)
    local swing, miss, heal, fall, debuff, cast = unpack(data.events)
    assert(
        swing.spell == "Melee" and swing.amount == 100 and swing.critical and swing.health == 900
    )
    assert(swing.overkill == nil and swing.source == "Wolf")
    assert(miss.missType == "DODGE" and miss.spell == "Bite" and miss.spellId == nil)
    assert(heal.amount == 150 and heal.overhealing == 50 and heal.spellId == 2061)
    assert(fall.environment == "Falling" and fall.amount == 80)
    assert(debuff.kind == "aura" and debuff.spell == "Rabies")
    assert(cast.kind == "cast" and cast.target == "Wolf" and cast.spell == "Arcane Shot")
    assert(data.inCombat == true and data.dead == false and data.health == 900)
end)

it("death recaps name the killing blow, rank damage and keep the newest five", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(ns.CombatLog.Read({}).deathCount == 0)
    log(970, "SWING_DAMAGE", WOLF, "Old Wolf", PLAYER, "Hunter", 10, -1, 1)
    health = 950
    log(990, "SWING_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", 50, -1, 1)
    health = 500
    log(992, "SPELL_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", 0, "Bite", 1, 450, -1, 1)
    log(993, "SPELL_HEAL", PRIEST, "Priest", PLAYER, "Hunter", 0, "Heal", 2, 200, 0)
    health = 0
    log(1000, "SWING_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", 700, 30, 1)
    die()
    -- The killing blow may arrive after PLAYER_DEAD; the recap waits for it.
    log(1000, "SPELL_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", 0, "Bite", 1, 5, -1, 1)
    assert(ns.CombatLog.Read({}).deathCount == 0)
    flush()

    now = 1030
    local data = ns.Character.Inspect({ kind = "combat", args = {} }).data
    assert(data.view == "deaths" and data.deathCount == 1 and #data.deaths == 1)
    local recap = data.deaths[1]
    assert(recap.zone == "Westfall" and recap.level == 12 and recap.secondsAgo == 30)
    assert(recap.killingBlow.amount == 700 and recap.killingBlow.overkill == 30)
    assert(recap.killingBlow.secondsBeforeDeath == 0)
    assert(recap.damageTaken == 1205 and recap.healingReceived == 200)
    assert(recap.damageBySource[1].ability == "Melee" and recap.damageBySource[1].amount == 750)
    assert(recap.damageBySource[2].ability == "Bite" and recap.damageBySource[2].hits == 2)
    assert(recap.secondsFromHighHealth == 10)
    assert(#recap.events == 5 and recap.events[1].secondsBeforeDeath == 10)
    assert(#ns.CombatLog.Read({ eventLimit = 2 }).deaths[1].events == 2)

    for index = 1, 6 do
        now = 2000 + index * 100
        log(now, "SWING_DAMAGE", WOLF, "Wolf " .. index, PLAYER, "Hunter", 1, -1, 1)
        die()
        flush()
    end
    local all = ns.CombatLog.Read({ deaths = 5 })
    assert(all.deathCount == 5 and #all.deaths == 5)
    assert(all.deaths[1].killingBlow.source == "Wolf 6")
    assert(all.deaths[5].killingBlow.source == "Wolf 2")
end)

it("the rolling buffer is bounded and drops secret values", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    for index = 1, 320 do
        log(1000, "SWING_DAMAGE", WOLF, "Wolf", PLAYER, "Hunter", index, -1, 1)
    end
    local data = ns.CombatLog.Read({ view = "recent", eventLimit = 60 })
    assert(data.retainedCount == 300 and data.matched == 300 and data.truncated)
    assert(data.events[60].amount == 320 and data.events[1].amount == 261)

    now = 1200
    assert(ns.CombatLog.Read({ view = "recent", lastSeconds = 120 }).matched == 0)

    function issecretvalue(value)
        return value == "secret"
    end
    log(1200, "SWING_DAMAGE", WOLF, "secret", PLAYER, "Hunter", "secret", -1, 1)
    local row = ns.CombatLog.Read({ view = "recent" }).events[1]
    assert(row.source == nil and row.amount == nil)

    ns.CombatLog.Clear()
    assert(ns.CombatLog.Read({ view = "recent" }).retainedCount == 0)
end)
