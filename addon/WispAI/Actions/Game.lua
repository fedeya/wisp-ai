local _, ns = ...
local actions = {}
local readWaypoint = ns.Character._ReadWaypoint
local macroLimits = ns.Character._MacroLimits
local function sameWaypoint(a, b)
    return a
        and b
        and a.mapId == b.mapId
        and math.abs(a.x - b.x) < 0.001
        and math.abs(a.y - b.y) < 0.001
end
function actions.set_waypoint(args)
    assert(
        C_Map and C_Map.GetUserWaypoint and C_Map.SetUserWaypoint and UiMapPoint,
        "Native waypoint API is unavailable"
    )
    assert(
        type(args.mapId) == "number"
            and type(args.x) == "number"
            and type(args.y) == "number"
            and args.x >= 0
            and args.x <= 100
            and args.y >= 0
            and args.y <= 100,
        "Use a valid map and coordinates from 0 to 100"
    )
    local info = C_Map.GetMapInfo(args.mapId)
    assert(
        info and C_Map.CanSetUserWaypointOnMap(args.mapId),
        "This map cannot accept a native user waypoint"
    )
    local previous, owned = readWaypoint(), ns.db.wispWaypoint
    local original = previous
    if
        sameWaypoint(previous, owned)
        and owned.owner == UnitName("player")
        and owned.realm == GetRealmName()
    then
        original = owned.previous
    end
    local wasSet = C_Map.SetUserWaypoint(
        UiMapPoint.CreateFromCoordinates(args.mapId, args.x / 100, args.y / 100)
    )
    assert(
        wasSet ~= false and sameWaypoint(readWaypoint(), args),
        "The game did not confirm the requested waypoint"
    )
    ns.db.wispWaypoint = {
        mapId = args.mapId,
        x = args.x,
        y = args.y,
        label = args.label,
        source = args.source,
        previous = original,
        owner = UnitName("player"),
        realm = GetRealmName(),
    }
    local navigation = false
    if args.navigate and C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then
        local ok = pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, true)
        if ok and C_SuperTrack.IsSuperTrackingUserWaypoint then
            local readOK, tracked = pcall(C_SuperTrack.IsSuperTrackingUserWaypoint)
            navigation = readOK and tracked == true
        end
    end
    return {
        applied = true,
        mapId = args.mapId,
        mapName = info.name,
        x = args.x,
        y = args.y,
        label = args.label,
        source = args.source,
        navigation = navigation,
        reference = {
            kind = "map",
            label = args.label,
            mapId = args.mapId,
            x = args.x,
            y = args.y,
            source = args.source,
        },
        note = "Placed the native map pin. The character was not moved. Navigation is reported separately.",
    }
end
function actions.clear_waypoint()
    assert(C_Map and C_Map.GetUserWaypoint, "Native waypoint API is unavailable")
    local owned = ns.db.wispWaypoint
    assert(owned, "Wisp has no recorded map marker to remove")
    assert(
        owned.owner == UnitName("player") and owned.realm == GetRealmName(),
        "This character has no Wisp marker to remove"
    )
    assert(
        sameWaypoint(readWaypoint(), owned),
        "The current marker was changed by the player; it was left untouched"
    )
    if owned.previous then
        local old = owned.previous
        assert(
            C_Map.SetUserWaypoint(
                UiMapPoint.CreateFromCoordinates(old.mapId, old.x / 100, old.y / 100)
            ) ~= false,
            "The previous marker could not be restored"
        )
        assert(sameWaypoint(readWaypoint(), old), "The game did not confirm the restored marker")
    else
        assert(C_Map.ClearUserWaypoint, "Clearing map markers is unavailable")
        C_Map.ClearUserWaypoint()
        assert(not readWaypoint(), "The game did not confirm removal of the marker")
    end
    ns.db.wispWaypoint = nil
    return { applied = true, restoredPrevious = owned.previous ~= nil }
end
local macroCommands = {
    cast = true,
    castsequence = true,
    castrandom = true,
    use = true,
    userandom = true,
    stopcasting = true,
    stopmacro = true,
    target = true,
    targetexact = true,
    targetenemy = true,
    targetfriend = true,
    cleartarget = true,
    focus = true,
    clearfocus = true,
    assist = true,
    petattack = true,
    petfollow = true,
    petpassive = true,
    petdefensive = true,
    petassist = true,
    startattack = true,
    stopattack = true,
    cancelaura = true,
    dismount = true,
    cancelform = true,
    equip = true,
    equipslot = true,
}
local function validateMacro(args)
    assert(
        type(args.name) == "string"
            and args.name:find("%S")
            and #args.name <= 16
            and not args.name:find("[%c|%[%]()]"),
        "Use a short plain macro name"
    )
    assert(type(args.body) == "string", "Macro text is required")
    local body = args.body:gsub("\r\n", "\n"):gsub("\r", "\n")
    assert(
        body:find("%S") and #body <= 255 and not body:find("[%z\1-\8\11\12\14-\31|]"),
        "Macro text must contain at most 255 UTF-8 bytes"
    )
    for line in (body .. "\n"):gmatch("([^\n]*)\n") do
        local text = line:match("^%s*(.-)%s*$")
        if text ~= "" then
            local directive = text:match("^#([%a]+)%s") or text:match("^#([%a]+)$")
            local command = text:match("^/([%a]+)%s") or text:match("^/([%a]+)$")
            assert(
                (directive and (directive:lower() == "showtooltip" or directive:lower() == "show"))
                    or (command and macroCommands[command:lower()]),
                "Only standard spell/item/targeting macro commands are supported; scripts, console, click and chat commands are not"
            )
        end
    end
    return body
end
function actions.create_macro(args)
    local body = validateMacro(args)
    assert(InCombatLockdown, "Combat state is unavailable; no macro was created")
    assert(
        not InCombatLockdown(),
        "Leave combat before creating a macro. No macro was queued or executed"
    )
    assert(
        CreateMacro and GetMacroIndexByName and GetMacroInfo,
        "Macro creation API is unavailable"
    )
    local index = GetMacroIndexByName(args.name)
    local created = false
    if index and index > 0 then
        local _, _, existing = GetMacroInfo(index)
        assert(
            existing == body,
            "A different macro with this name already exists. Choose another name; existing macros were left unchanged"
        )
    else
        local account, character = GetNumMacros()
        local accountLimit, characterLimit = macroLimits()
        local limit, count =
            args.perCharacter and characterLimit or accountLimit,
            args.perCharacter and character or account
        assert(limit and count < limit, "No free macro slots in the selected scope")
        index = CreateMacro(args.name, 134400, body, args.perCharacter)
        assert(
            type(index) == "number" and index > 0,
            "The game did not confirm creation of the macro"
        )
        created = true
    end
    local name, _, actualBody = GetMacroInfo(index)
    local verified = name == args.name and actualBody == body
    local accountLimit = macroLimits()
    local scope = accountLimit and (index <= accountLimit and "account" or "character") or "unknown"
    return {
        created = created,
        verified = verified,
        name = name or args.name,
        body = actualBody or body,
        scope = scope,
        reference = { kind = "macro", label = args.name, name = args.name },
        note = "Macro was not executed or placed on an action bar. Click its reference to pick it up yourself.",
    }
end
function ns.Actions.PerformAction(action)
    local expected = action and action.expectedCharacter
    if not expected or expected.name ~= UnitName("player") or expected.realm ~= GetRealmName() then
        return {
            status = "blocked",
            error = "Character identity changed; request the action again for the current character",
        }
    end
    local apply = actions[action.kind]
    if action.kind == "update_settings" then
        apply = ns.Settings.UpdateSettings
    end
    if action.kind == "undo_settings" then
        apply = function(args)
            return ns.Settings.ApplySettings(args.transactionId, true)
        end
    end
    if not apply then
        return { status = "unavailable", error = "Unknown action" }
    end
    local ok, result = pcall(apply, action.args or {})
    return {
        capturedAt = time(),
        character = UnitName("player"),
        source = "WoW addon action API",
        status = ok and "completed" or "blocked",
        data = ok and result or nil,
        error = not ok and tostring(result) or nil,
    }
end
