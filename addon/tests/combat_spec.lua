local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace({ db = {}, chats = {} })
        now = 1000
        combat = false
        timers = {}
        recaps = {}
        sessions = {}
        meterAvailable = true
        function time()
            return now
        end
        function UnitName()
            return "Hunter"
        end
        function UnitGUID()
            return "Player-1"
        end
        function UnitLevel()
            return 12
        end
        function UnitAffectingCombat()
            return combat
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
        -- A nil recap ID means the latest death, as in the game.
        C_DeathRecap = {
            HasRecapEvents = function(id)
                return recaps[id or "latest"] ~= nil
            end,
            GetRecapEvents = function(id)
                return recaps[id or "latest"].events
            end,
            GetRecapMaxHealth = function(id)
                return recaps[id or "latest"].maxHealth
            end,
        }
        Enum = {
            DamageMeterType = { DamageDone = 0, DamageTaken = 7, Deaths = 9 },
            DamageMeterSessionType = { Overall = 0, Current = 1 },
        }
        C_DamageMeter = {
            IsDamageMeterAvailable = function()
                return meterAvailable, meterAvailable and "" or "Damage meter disabled"
            end,
            GetSessionDurationSeconds = function()
                return 42
            end,
            GetCombatSessionFromType = function(sessionType, kind)
                assert(sessionType == 1)
                return sessions[kind]
            end,
            GetCombatSessionSourceFromType = function(sessionType, kind, guid)
                assert(sessionType == 1 and guid == "Player-1")
                return sessions["player" .. kind]
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
        -- Runs one second of timers; returns how many ran.
        function tick()
            local pending = timers
            timers = {}
            for _, fn in ipairs(pending) do
                fn()
            end
            return #pending
        end
        function die()
            combatHandler(nil, "PLAYER_DEAD")
            while tick() > 0 do
            end
        end
    end
    helper.addon("Combat/Combat.lua", env)
    do
        combatHandler = onEvent
    end
    helper.addon("Character/Inspect.lua", env)
end

it("copies the game's recap at each death and keeps the newest five", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(ns.Combat.Read({}).deathCount == 0)
    recaps.latest = {
        maxHealth = 1000,
        events = {
            {
                event = "SWING_DAMAGE",
                sourceName = "Defias Pillager",
                amount = 300,
                overkill = 40,
                currentHP = 260,
                timestamp = 999.5,
            },
            {
                event = "SPELL_DAMAGE",
                spellName = "Fireball",
                spellId = 0,
                sourceName = "Defias Pillager",
                amount = 450,
                currentHP = 710,
                timestamp = 997,
                school = 4,
                deadly = true,
            },
            {
                event = "ENVIRONMENTAL_DAMAGE",
                environmentalType = "Falling",
                amount = 50,
                currentHP = 760,
                timestamp = 994.5,
            },
            {
                event = "SPELL_DAMAGE",
                spellName = "Ambush",
                sourceName = "Hidden",
                hideCaster = true,
                amount = 240,
                absorbed = 20,
                currentHP = 1000,
                timestamp = 993,
            },
        },
    }
    die()

    now = 1030
    local result = ns.Character.Inspect({ kind = "combat", args = {} })
    assert(result.status == "available")
    local data = result.data
    assert(data.view == "deaths" and data.deathCount == 1 and data.inCombat == false)
    local death = data.deaths[1]
    assert(death.zone == "Westfall" and death.level == 12 and death.secondsAgo == 30)
    assert(death.recapAvailable == true and death.maxHealth == 1000 and death.damageTaken == 1040)
    local blow = death.killingBlow
    assert(blow.causedDeath and blow.spell == "Melee" and blow.overkill == 40)
    assert(blow.source == "Defias Pillager" and blow.secondsBeforeDeath == 0)
    assert(blow.healthPercent == 26)
    local fireball, fall, ambush = death.events[2], death.events[3], death.events[4]
    assert(fireball.spell == "Fireball" and fireball.spellId == nil and fireball.deadly)
    assert(fireball.secondsBeforeDeath == 2.5 and not fireball.causedDeath)
    assert(fall.spell == "Falling" and fall.environment == "Falling")
    assert(ambush.source == nil and ambush.absorbed == 20)
    assert(death.secondsCovered == 6.5)
    local top = death.damageBySource[1]
    assert(top.source == "Defias Pillager" and top.ability == "Fireball" and top.amount == 450)
    assert(#ns.Combat.Read({ eventLimit = 2 }).deaths[1].events == 2)

    recaps.latest = nil
    die()
    assert(ns.Combat.Read({}).deaths[1].recapAvailable == false)

    for index = 1, 6 do
        recaps.latest = {
            maxHealth = 1000,
            events = { { event = "SWING_DAMAGE", sourceName = "Wolf " .. index, amount = 1 } },
        }
        die()
    end
    local all = ns.Combat.Read({ deaths = 5 })
    assert(all.deathCount == 5 and #all.deaths == 5)
    assert(all.deaths[1].killingBlow.source == "Wolf 6")
    assert(all.deaths[5].killingBlow.source == "Wolf 2")
end)

it("reads group deaths and the last fight from the meter only after combat", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    recaps[77] = {
        maxHealth = 3000,
        events = {
            { event = "SPELL_DAMAGE", spellName = "Cleave", sourceName = "Hogger", amount = 900 },
        },
    }
    sessions[9] = {
        combatSources = {
            { name = "Hunter", isLocalPlayer = true, deathRecapID = 76 },
            { name = "Tank", classFilename = "WARRIOR", deathRecapID = 77, deathTimeSeconds = 31 },
            { name = "Healer", classFilename = "PRIEST", deathRecapID = 0 },
        },
    }
    sessions.player7 = {
        totalAmount = 1500,
        combatSpells = {
            { spellID = 0, creatureName = "Hogger", totalAmount = 400, isAvoidable = true },
            { spellID = 6603, creatureName = "Hogger", totalAmount = 1100, overkillAmount = 10 },
        },
    }
    sessions.player0 = { totalAmount = 2400 }
    sessions[7] = {
        combatSources = {
            { name = "Hunter", classFilename = "HUNTER", isLocalPlayer = true, totalAmount = 1500 },
            { name = "Tank", classFilename = "WARRIOR", totalAmount = 5200 },
        },
    }

    combat = true
    local hidden = ns.Combat.Read({ includeGroup = true })
    assert(hidden.groupDeaths == nil and hidden.groupUnavailable:find("during combat"))
    assert(ns.Combat.Read({ view = "fight" }).unavailable:find("during combat"))

    combat = false
    local group = ns.Combat.Read({ includeGroup = true }).groupDeaths
    assert(#group == 2)
    assert(group[1].name == "Tank" and group[1].class == "WARRIOR")
    assert(group[1].killingBlow.spell == "Cleave" and group[1].killingBlow.source == "Hogger")
    assert(group[1].deathTimeSeconds == 31 and group[1].recapAvailable == true)
    assert(group[2].name == "Healer" and group[2].killingBlow == nil)
    assert(group[2].recapAvailable == false and group[2].events == nil)

    local fight = ns.Character.Inspect({ kind = "combat", args = { view = "fight" } }).data.fight
    assert(fight.durationSeconds == 42 and fight.damageTaken == 1500 and fight.damageDone == 2400)
    assert(
        fight.damageTakenBySpell[1].spellId == 6603 and fight.damageTakenBySpell[1].overkill == 10
    )
    assert(fight.damageTakenBySpell[2].spellId == nil and fight.damageTakenBySpell[2].avoidable)
    assert(fight.groupDamageTaken[1].isPlayer and fight.groupDamageTaken[2].damageTaken == 5200)

    meterAvailable = false
    assert(ns.Combat.Read({ view = "fight" }).unavailable == "Damage meter disabled")
    C_DamageMeter = nil
    assert(ns.Combat.Read({ view = "fight" }).unavailable:find("not available"))
end)

it("drops secret values and survives a failing recap API", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    function issecretvalue(value)
        return value == "secret"
    end
    recaps.latest = {
        maxHealth = "secret",
        events = { { event = "SWING_DAMAGE", sourceName = "secret", amount = "secret" } },
    }
    die()
    local death = ns.Combat.Read({}).deaths[1]
    assert(death.maxHealth == nil and death.killingBlow.source == nil)
    assert(death.killingBlow.amount == nil and death.damageTaken == 0)

    C_DeathRecap.GetRecapEvents = function()
        error("recap failed")
    end
    recaps.latest = { events = {} }
    die()
    assert(ns.Combat.Read({}).deaths[1].recapAvailable == false)

    ns.Combat.Clear()
    assert(ns.Combat.Read({}).deathCount == 0)
end)

it("waits for a late recap and gives up after five seconds", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    -- The recap shows up on the third check; the death keeps the zone it happened in.
    combatHandler(nil, "PLAYER_DEAD")
    function GetRealZoneText()
        return "Duskwood"
    end
    tick()
    tick()
    assert(ns.Combat.Read({}).deathCount == 0)
    recaps.latest = {
        maxHealth = 1000,
        events = { { event = "SWING_DAMAGE", sourceName = "Stitches", amount = 900 } },
    }
    tick()
    assert(#timers == 0)
    local death = ns.Combat.Read({}).deaths[1]
    assert(death.recapAvailable == true and death.killingBlow.source == "Stitches")
    assert(death.zone == "Westfall")

    -- Without a recap, the death is still recorded after the last attempt.
    recaps.latest = nil
    combatHandler(nil, "PLAYER_DEAD")
    local seconds = 0
    while tick() > 0 do
        seconds = seconds + 1
    end
    assert(seconds == 5)
    local all = ns.Combat.Read({ deaths = 2 })
    assert(all.deathCount == 2 and all.deaths[1].recapAvailable == false)
end)
