local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        C = { db = {} }
        function time()
            return 123
        end
        function UnitName()
            return "Mage"
        end
        function GetRealmName()
            return "Realm"
        end
        CreateFrame = function()
            return { RegisterEvent = function() end, SetScript = function() end }
        end
        identity = { name = "Mage", realm = "Realm" }
        function point(id, x, y)
            return {
                uiMapID = id,
                position = {
                    GetXY = function()
                        return x, y
                    end,
                },
            }
        end
        UiMapPoint = { CreateFromCoordinates = point }
        C_Map = {
            GetMapInfo = function(id)
                if id == 1 then
                    return { mapID = 1, name = "Durotar", parentMapID = 0 }
                end
            end,
            CanSetUserWaypointOnMap = function(id)
                return id == 1
            end,
            GetUserWaypoint = function()
                return waypoint
            end,
            SetUserWaypoint = function(value)
                waypoint = value
                return true
            end,
            ClearUserWaypoint = function()
                waypoint = nil
            end,
        }
        Constants = { MacroConsts = { MAX_ACCOUNT_MACROS = 120, MAX_CHARACTER_MACROS = 30 } }
        macros = {}
        creates = 0
        function InCombatLockdown()
            return combat or false
        end
        function GetNumMacros()
            return 0, creates
        end
        function GetMacroIndexByName(name)
            for index, macro in pairs(macros) do
                if macro.name == name then
                    return index
                end
            end
            return 0
        end
        function GetMacroInfo(index)
            local macro = macros[index]
            if macro then
                return macro.name, 134400, macro.body
            end
        end
        function CreateMacro(name, icon, body, perCharacter)
            creates = creates + 1
            local index = perCharacter and 120 + creates or creates
            macros[index] = { name = name, body = body }
            return index
        end
        function RunMacroText()
            error("must not execute macros")
        end
        function EditMacro()
            error("must not overwrite")
        end
        function DeleteMacro()
            error("must not delete")
        end
        function act(kind, args)
            return C.PerformAction({ kind = kind, args = args or {}, expectedCharacter = identity })
        end
    end
    helper.addon("Character.lua", env)
end

it(
    "map actions convert percent coordinates, verify readback, and undo only their own pin",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        waypoint = point(1, 0.1, 0.2)
        local r = act(
            "set_waypoint",
            { mapId = 1, x = 60, y = 40, label = "NPC", source = "user", navigate = false }
        )
        assert(r.status == "completed" and r.data.applied)
        local x, y = waypoint.position:GetXY()
        assert(x == 0.6 and y == 0.4)
        r = act("clear_waypoint")
        x, y = waypoint.position:GetXY()
        assert(r.data.restoredPrevious and x == 0.1 and y == 0.2)
        waypoint = nil
        assert(
            act("set_waypoint", { mapId = 1, x = 50, y = 50, label = "A", source = "user" }).status
                == "completed"
        )
        assert(
            act("set_waypoint", { mapId = 1, x = 60, y = 60, label = "B", source = "user" }).status
                == "completed"
        )
        assert(
            act("clear_waypoint").status == "completed" and waypoint == nil,
            "replacing an owned pin must retain the original empty state"
        )
        act("set_waypoint", { mapId = 1, x = 50, y = 50, label = "A", source = "user" })
        waypoint = point(1, 0.7, 0.8)
        assert(act("clear_waypoint").status == "blocked")
        x, y = waypoint.position:GetXY()
        assert(x == 0.7 and y == 0.8, "user changes must remain untouched")
    end
)

it("Forever plain-coordinate waypoint readings preserve placement, metadata and undo", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_Map.GetBestMapForUnit = function()
        return 1
    end
    C_Map.GetUserWaypoint = function()
        if waypoint then
            local x, y = waypoint.position:GetXY()
            return { uiMapID = waypoint.uiMapID, position = { x = x, y = y } }
        end
    end
    waypoint = point(1, 0.1, 0.2)
    local inspected = C.Inspect({ kind = "map", args = {} })
    assert(inspected.status == "available", inspected.error)
    assert(inspected.data.waypoint.x == 10 and inspected.data.waypoint.y == 20)
    local r = act("set_waypoint", {
        mapId = 1,
        x = 52.4,
        y = 11.65,
        label = "Samo",
        source = "QuestieDB Forever",
    })
    assert(r.status == "completed", r.error)
    assert(r.data.applied and r.data.reference.x == 52.4 and r.data.reference.y == 11.65)
    assert(C.db.wispWaypoint.label == "Samo" and C.db.wispWaypoint.source == "QuestieDB Forever")
    assert(C.db.wispWaypoint.previous.x == 10 and C.db.wispWaypoint.previous.y == 20)
    r = act("set_waypoint", { mapId = 1, x = 60, y = 40, label = "Second", source = "user" })
    assert(r.status == "completed", r.error)
    r = act("clear_waypoint")
    assert(r.status == "completed" and r.data.restoredPrevious, r.error)
    local x, y = waypoint.position:GetXY()
    assert(x == 0.1 and y == 0.2)
    assert(C.db.wispWaypoint == nil)
    act("set_waypoint", { mapId = 1, x = 52.4, y = 11.65, label = "Samo", source = "user" })
    waypoint = point(1, 0.7, 0.8)
    assert(act("clear_waypoint").status == "blocked")
    x, y = waypoint.position:GetXY()
    assert(x == 0.7 and y == 0.8, "a player-edited plain-coordinate pin must stay untouched")
end)

it("malformed native waypoint coordinates block placement without overwriting the pin", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    local sets = 0
    C_Map.SetUserWaypoint = function()
        sets = sets + 1
    end
    C_Map.GetUserWaypoint = function()
        return { uiMapID = 1, position = { x = "unknown", y = 0.2 } }
    end
    local r =
        act("set_waypoint", { mapId = 1, x = 52.4, y = 11.65, label = "Samo", source = "user" })
    assert(r.status == "blocked" and sets == 0)
    assert(r.error:find("waypoint coordinates", 1, true), r.error)
    assert(C.db.wispWaypoint == nil)
end)

it("unsupported maps and character switches never apply actions", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    assert(
        act("set_waypoint", { mapId = 999, x = 10, y = 20, label = "No", source = "user" }).status
                == "blocked"
            and waypoint == nil
    )
    identity.name = "Other"
    assert(
        act("create_macro", { name = "Nova", body = "/cast Frost Nova", perCharacter = true }).status
                == "blocked"
            and creates == 0
    )
end)

it("optional navigation failures do not hide a successfully placed and verified pin", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    C_SuperTrack = {
        SetSuperTrackedUserWaypoint = function() end,
        IsSuperTrackingUserWaypoint = function()
            error("not available")
        end,
    }
    local r = act(
        "set_waypoint",
        { mapId = 1, x = 20, y = 30, label = "NPC", source = "user", navigate = true }
    )
    assert(r.status == "completed" and r.data.applied and not r.data.navigation)
    C_SuperTrack.IsSuperTrackingUserWaypoint = function()
        return true
    end
    r = act(
        "set_waypoint",
        { mapId = 1, x = 21, y = 31, label = "NPC", source = "user", navigate = true }
    )
    assert(r.data.navigation)
end)

it(
    "macro creation is verified, idempotent, never overwrites and respects combat/capacity",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        local args = { name = "Nova", body = "#showtooltip\n/cast Frost Nova", perCharacter = true }
        local r = act("create_macro", args)
        assert(
            r.status == "completed"
                and r.data.created
                and r.data.verified
                and r.data.scope == "character"
        )
        assert(
            r.data.reference.kind == "macro" and r.data.reference.name == "Nova" and creates == 1
        )
        r = act("create_macro", args)
        assert(r.status == "completed" and not r.data.created and creates == 1)
        assert(
            act("create_macro", { name = "Nova", body = "/cast Frostbolt", perCharacter = true }).status
                    == "blocked"
                and creates == 1
        )
        combat = true
        assert(
            act("create_macro", { name = "Bolt", body = "/cast Frostbolt", perCharacter = true }).status
                    == "blocked"
                and creates == 1
        )
        combat = false
        assert(
            act("create_macro", { name = "Lua", body = "/run print(1)", perCharacter = true }).status
                    == "blocked"
                and creates == 1
        )
        GetNumMacros = function()
            return 120, 30
        end
        assert(
            act("create_macro", { name = "Full", body = "/cast Frostbolt", perCharacter = true }).status
                    == "blocked"
                and creates == 1
        )
    end
)

it("macro inventory hides code by default and includes it only when requested", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    act("create_macro", { name = "Nova", body = "/cast Frost Nova", perCharacter = true })
    local r = C.Inspect({ kind = "macros", args = {} })
    assert(r.data.macros[1].name == "Nova" and r.data.macros[1].body == nil)
    r = C.Inspect({ kind = "macros", args = { names = { "Nova" }, includeBodies = true } })
    assert(r.data.macros[1].body == "/cast Frost Nova")
end)
