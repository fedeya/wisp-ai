local _, ns = ...
local function scalar(value)
    return type(value) == "string"
        or type(value) == "boolean"
        or (type(value) == "number" and value == value and math.abs(value) < math.huge)
end
local function plain(value)
    return tostring(value or "")
        :gsub("|c%x%x%x%x%x%x%x%x", "")
        :gsub("|r", "")
        :gsub("[%c|]", "")
        :sub(1, 500)
end
local function encode(value)
    return tostring(value):gsub("([^%w_-])", function(char)
        return string.format("%%%02X", char:byte())
    end)
end
local function owner()
    return GetRealmName() .. ":" .. UnitName("player")
end
local function registry()
    return LibStub and LibStub("AceConfigRegistry-3.0", true)
end
local function invoke(member, handler, info, ...)
    if type(member) == "function" then
        return member(info, ...)
    end
    if type(member) == "string" and handler and type(handler[member]) == "function" then
        return handler[member](handler, info, ...)
    end
    error("Unsupported settings callback")
end
local function evaluate(member, _, info)
    if type(member) == "function" then
        return member(info)
    end
    return member
end
local function callbackValue(member, handler, info)
    if type(member) == "string" or type(member) == "function" then
        return invoke(member, handler, info)
    end
    return member
end
local gameNames = {
    "autoLootDefault",
    "autoDismountFlying",
    "autoSelfCast",
    "ActionButtonUseKeyDown",
    "lockActionBars",
    "alwaysShowActionBars",
    "showTargetOfTarget",
    "ShowClassColorInNameplate",
    "nameplateShowEnemies",
    "nameplateShowFriends",
    "nameplateShowAll",
    "nameplateShowEnemyPets",
    "nameplateShowEnemyGuardians",
    "nameplateShowEnemyMinions",
    "nameplateShowFriendlyPets",
    "nameplateShowFriendlyGuardians",
    "nameplateShowFriendlyMinions",
    "nameplateMotion",
    "nameplateMaxDistance",
    "nameplateMinScale",
    "nameplateMaxScale",
    "nameplateSelectedScale",
    "nameplateGlobalScale",
    "nameplateOverlapH",
    "nameplateOverlapV",
    "cameraDistanceMaxZoomFactor",
    "cameraYawMoveSpeed",
    "cameraPitchMoveSpeed",
    "cameraSmoothStyle",
    "Sound_EnableAllSound",
    "Sound_EnableMusic",
    "Sound_EnableSFX",
    "Sound_EnableAmbience",
    "Sound_EnableDialog",
    "Sound_MasterVolume",
    "Sound_MusicVolume",
    "Sound_SFXVolume",
    "Sound_AmbienceVolume",
    "Sound_DialogVolume",
    "Sound_EnableSoundWhenGameIsInBG",
    "colorblindMode",
    "colorblindSimulator",
    "useUiScale",
    "uiScale",
    "graphicsQuality",
    "graphicsViewDistance",
    "graphicsEnvironmentDetail",
    "graphicsGroundClutter",
    "graphicsShadowQuality",
    "graphicsLiquidDetail",
    "graphicsParticleDensity",
    "graphicsSSAO",
    "graphicsSunshafts",
    "spellClutter",
    "projectedTextures",
    "maxFPS",
    "maxFPSBk",
    "showTutorials",
    "countdownForCooldowns",
    "floatingCombatTextCombatDamage",
    "floatingCombatTextCombatHealing",
}
local function cvar(name)
    if
        not name:match("^[%w_]+$")
        or name:lower():find("password")
        or name:lower():find("token")
        or name:lower():find("account")
    then
        return nil
    end
    local api = C_CVar or {}
    local get = api.GetCVar or GetCVar
    if not get then
        return nil
    end
    local ok, value = pcall(get, name)
    if not ok or value == nil then
        return nil
    end
    local metadata = api.GetCVarInfo or GetCVarInfo
    local good, _, default, _, _, locked, secure, readOnly
    if metadata then
        good, _, default, _, _, locked, secure, readOnly = pcall(metadata, name)
    end
    local function normalize(new)
        if type(new) == "boolean" then
            return new and "1" or "0"
        end
        local number = tonumber(new)
        if number and scalar(number) then
            return tostring(number)
        end
        return tostring(new)
    end
    return {
        id = "cvar:" .. name,
        provider = "game",
        name = name,
        label = name,
        type = "input",
        value = normalize(value),
        default = default,
        writable = good == true
            and locked == false
            and secure == false
            and readOnly == false
            and (api.SetCVar or SetCVar) ~= nil,
        read = function()
            local result = get(name)
            if result == nil then
                error("Setting unavailable")
            end
            return normalize(result)
        end,
        write = function(new)
            (api.SetCVar or SetCVar)(
                name,
                type(new) == "boolean" and (new and "1" or "0") or tostring(new)
            )
        end,
        normalize = normalize,
    }
end
local function aceOptions(app)
    local reg = registry()
    if not reg then
        return {}
    end
    local ok, root = pcall(reg.GetOptionsTable, reg, app, "dialog", "WispAI-1.0")
    if not ok or type(root) ~= "table" then
        return {}
    end
    local found, count = {}, 0
    local function walk(node, path, inherited, blocked, hidden, depth)
        if type(node) ~= "table" or depth > 10 or count >= 2500 then
            return
        end
        count = count + 1
        local state = {}
        for k, v in pairs(inherited) do
            state[k] = v
        end
        for _, k in ipairs({ "handler", "get", "set", "validate", "confirm" }) do
            if node[k] ~= nil then
                state[k] = node[k]
            end
        end
        local info = {
            options = root,
            option = node,
            type = node.type,
            arg = node.arg,
            handler = state.handler,
            appName = app,
            uiType = "dialog",
            uiName = "WispAI-1.0",
        }
        info[0] = app
        for i, key in ipairs(path) do
            info[i] = key
        end
        local disabledOK, disabled = pcall(callbackValue, node.disabled, state.handler, info)
        local hiddenOK, invisible = pcall(callbackValue, node.hidden, state.handler, info)
        blocked = blocked or not disabledOK or disabled == true or node.dialogDisabled == true
        hidden = hidden or not hiddenOK or invisible == true or node.dialogHidden == true
        if hidden then
            return
        end
        if node.type == "group" then
            local args = {}
            for key, child in pairs(node.args or {}) do
                args[key] = child
            end
            for _, plugin in pairs(node.plugins or {}) do
                for key, child in pairs(plugin) do
                    args[key] = child
                end
            end
            local keys = {}
            for key in pairs(args) do
                if type(key) == "string" then
                    keys[#keys + 1] = key
                end
            end
            table.sort(keys)
            for _, key in ipairs(keys) do
                local nextPath = {}
                for i, part in ipairs(path) do
                    nextPath[i] = part
                end
                nextPath[#nextPath + 1] = key
                walk(args[key], nextPath, state, blocked, hidden, depth + 1)
            end
        elseif
            node.type == "toggle"
            or node.type == "range"
            or node.type == "select"
            or node.type == "input"
        then
            local nameOK, name = pcall(evaluate, node.name, state.handler, info)
            local descOK, desc = pcall(evaluate, node.desc, state.handler, info)
            local pieces = {}
            for i, part in ipairs(path) do
                pieces[i] = encode(part)
            end
            local descriptor = {
                id = "ace:" .. encode(app) .. ":" .. table.concat(pieces, "/"),
                provider = "ace",
                addon = app,
                path = path,
                label = plain(nameOK and name or path[#path]),
                description = plain(descOK and desc),
                type = node.type,
                writable = not blocked and state.get ~= nil and state.set ~= nil,
                min = node.min,
                max = node.max,
                step = node.step,
            }
            local semantic = table.concat(path, "/"):lower()
            for _, token in ipairs({
                "script",
                "code",
                "lua",
                "customtrigger",
                "import",
                "export",
                "profile",
                "delete",
                "remove",
                "reset",
                "restore",
            }) do
                if semantic:find(token, 1, true) then
                    descriptor.writable = false
                    descriptor.reason = "This option requires a dedicated Wisp integration"
                    break
                end
            end
            descriptor.read = function()
                local value = invoke(state.get, state.handler, info)
                if not scalar(value) then
                    error("Setting is not a readable scalar")
                end
                return value
            end
            descriptor.write = function(value)
                invoke(state.set, state.handler, info, value)
            end
            descriptor.validate = function(value)
                if node.type == "toggle" and type(value) ~= "boolean" then
                    error("Expected a boolean")
                end
                if node.type == "input" and type(value) ~= "string" then
                    error("Expected text")
                end
                if
                    node.type == "input"
                    and type(node.pattern) == "string"
                    and not value:match(node.pattern)
                then
                    error("Text does not match this option's format")
                end
                if node.type == "range" then
                    if
                        type(value) ~= "number"
                        or (node.min and value < node.min)
                        or (node.max and value > node.max)
                    then
                        error("Number outside the allowed range")
                    end
                end
                if node.type == "select" then
                    local values = callbackValue(node.values, state.handler, info)
                    if type(values) ~= "table" or values[value] == nil then
                        error("Unknown option")
                    end
                end
                if state.validate and state.validate ~= false then
                    local valid = invoke(state.validate, state.handler, info, value)
                    if valid ~= true then
                        error(type(valid) == "string" and valid or "Validation rejected the value")
                    end
                end
            end
            descriptor.requiresConfirmation = state.confirm ~= nil and state.confirm ~= false
            if node.type == "select" then
                local valuesOK, values = pcall(callbackValue, node.values, state.handler, info)
                if valuesOK and type(values) == "table" then
                    descriptor.options = {}
                    for key, label in pairs(values) do
                        if scalar(key) and #descriptor.options < 100 then
                            descriptor.options[#descriptor.options + 1] =
                                { value = key, label = plain(label) }
                        end
                    end
                    table.sort(descriptor.options, function(a, b)
                        return tostring(a.value) < tostring(b.value)
                    end)
                else
                    descriptor.writable = false
                end
            end
            found[#found + 1] = descriptor
        end
    end
    walk(root, {}, {}, false, false, 0)
    return found
end
local function applications()
    local reg, apps = registry(), {}
    if reg and reg.IterateOptionsTables then
        for name in reg:IterateOptionsTables() do
            apps[#apps + 1] = name
        end
    end
    table.sort(apps)
    return apps
end
local function descriptors(args)
    local all = {}
    if args.provider ~= "ace" and not args.addon then
        local names = {}
        for _, name in ipairs(gameNames) do
            names[name] = true
        end
        for _, id in ipairs(args.ids or {}) do
            local name = id:match("^cvar:([%w_]+)$")
            if name then
                names[name] = true
            end
        end
        for name in pairs(names) do
            local option = cvar(name)
            if option then
                all[#all + 1] = option
            end
        end
    end
    if args.provider ~= "game" then
        for _, app in ipairs(applications()) do
            if not args.addon or app == args.addon then
                for _, option in ipairs(aceOptions(app)) do
                    all[#all + 1] = option
                end
            end
        end
    end
    table.sort(all, function(a, b)
        return a.id < b.id
    end)
    return all
end
local function resolve(id)
    local name = id:match("^cvar:([%w_]+)$")
    if name then
        return cvar(name)
    end
    for _, app in ipairs(applications()) do
        if id:sub(1, #("ace:" .. encode(app) .. ":")) == "ace:" .. encode(app) .. ":" then
            for _, option in ipairs(aceOptions(app)) do
                if option.id == id then
                    return option
                end
            end
        end
    end
end
local function exposed(option)
    local result = {}
    for key, value in pairs(option) do
        if type(value) ~= "function" then
            result[key] = value
        end
    end
    local ok, value = pcall(option.read)
    if ok then
        result.value = value
    else
        result.value = nil
    end
    result.readable = ok
    if not ok then
        result.writable = false
        result.error = "Value is unavailable"
    end
    if ok and type(value) == "string" and value:find("[%c]") then
        result.writable = false
        result.reason = "Multiline settings require a dedicated integration"
    end
    return result
end
function ns.Settings.ReadSettings(args)
    args = args or {}
    local result = {
        applications = applications(),
        source = "Live game APIs and registered AceConfig options",
    }
    for _, section in ipairs(args.sections or { "options" }) do
        if section == "options" then
            local selected, ids = {}, {}
            for _, id in ipairs(args.ids or {}) do
                ids[id] = true
            end
            for _, option in ipairs(descriptors(args)) do
                local matches = not args.query
                    or (option.id .. " " .. option.label .. " " .. (option.description or ""))
                        :lower()
                        :find(args.query:lower(), 1, true)
                if (next(ids) and ids[option.id]) or (not next(ids) and matches) then
                    selected[#selected + 1] = option
                end
            end
            result.options = {}
            local offset, limit = args.offset or 0, args.limit or 30
            for index = offset + 1, math.min(#selected, offset + limit) do
                result.options[#result.options + 1] = exposed(selected[index])
            end
            result.total, result.offset = #selected, offset
            result.nextOffset = offset + limit < #selected and offset + limit or nil
        elseif section == "addons" then
            result.addons = {}
            local api = C_AddOns or {}
            local count = api.GetNumAddOns and api.GetNumAddOns() or 0
            for index = 1, count do
                local name, title = api.GetAddOnInfo(index)
                if name and not name:match("^WispAI_[BS]") then
                    result.addons[#result.addons + 1] = {
                        name = name,
                        title = plain(title),
                        loaded = api.IsAddOnLoaded and api.IsAddOnLoaded(name) == true,
                        version = api.GetAddOnMetadata and api.GetAddOnMetadata(name, "Version"),
                    }
                end
            end
        elseif section == "keybindings" then
            result.keybindings = {}
            local count = GetNumBindings and GetNumBindings() or 0
            for index = 1, count do
                local command, category, key1, key2 = GetBinding(index)
                if key1 or key2 then
                    result.keybindings[#result.keybindings + 1] = {
                        command = command,
                        label = plain(_G["BINDING_NAME_" .. command] or command),
                        category = category,
                        key1 = key1,
                        key2 = key2,
                    }
                end
            end
            result.bindingSet = GetCurrentBindingSet and GetCurrentBindingSet()
        elseif section == "action_bars" then
            result.actionBars = {}
            if GetActionInfo then
                for slot = 1, 180 do
                    local kind, id, subType = GetActionInfo(slot)
                    if kind then
                        result.actionBars[#result.actionBars + 1] =
                            { slot = slot, kind = kind, id = id, subType = subType }
                    end
                end
            end
            result.actionPage = GetActionBarPage and GetActionBarPage()
        end
    end
    return result
end
local function store()
    ns.db.settingsTransactions = ns.db.settingsTransactions or {}
    return ns.db.settingsTransactions
end
local function getTransaction(id)
    local tx = store()[id]
    if not tx or tx.owner ~= owner() then
        error("Settings proposal unavailable for this character")
    end
    return tx
end
local function check(option, value)
    if not option or not option.writable then
        error("Setting is unavailable or read-only")
    end
    if not scalar(value) or (type(value) == "string" and (#value > 1000 or value:find("[%c]"))) then
        error("Invalid setting value")
    end
    if option.validate then
        option.validate(value)
    end
    return option.normalize and option.normalize(value) or value
end
function ns.Settings.UpdateSettings(args)
    if InCombatLockdown and InCombatLockdown() then
        error("Leave combat before changing settings")
    end
    if args.operation == "preview" then
        local changes, seen = {}, {}
        for _, request in ipairs(args.changes or {}) do
            if seen[request.id] then
                error("Duplicate setting")
            end
            seen[request.id] = true
            local option = resolve(request.id)
            local value = check(option, request.value)
            local old = option.read()
            if type(old) == "string" and old:find("[%c]") then
                error("Multiline settings require a dedicated integration")
            end
            changes[#changes + 1] = {
                id = option.id,
                label = option.label,
                before = old,
                after = value,
                requiresConfirmation = option.requiresConfirmation,
            }
        end
        if #changes == 0 or #changes > 12 then
            error("Use 1 to 12 settings per proposal")
        end
        ns.db.settingsCounter = (ns.db.settingsCounter or 0) + 1
        local id = (ns.session or tostring(time())) .. "-settings-" .. ns.db.settingsCounter
        local tx =
            { id = id, owner = owner(), status = "preview", changes = changes, createdAt = time() }
        store()[id] = tx
        local entries = {}
        for key, item in pairs(store()) do
            entries[#entries + 1] = { key = key, at = item.createdAt }
        end
        table.sort(entries, function(a, b)
            return a.at < b.at
        end)
        for i = 1, math.max(0, #entries - 30) do
            store()[entries[i].key] = nil
        end
        return { transactionId = id, status = "preview", changes = changes, applied = false }
    end
    return ns.Settings.ApplySettings(args.transactionId, false)
end
function ns.Settings.ApplySettings(id, undo)
    if InCombatLockdown and InCombatLockdown() then
        error("Leave combat before changing settings")
    end
    local tx = getTransaction(id)
    if (not undo and tx.status == "applied") or (undo and tx.status == "undone") then
        for _, change in ipairs(tx.changes) do
            local option = resolve(change.id)
            local desired = change.after
            if undo then
                desired = change.before
            end
            if not option or option.read() ~= desired then
                error("Settings have changed since this operation")
            end
        end
        return {
            transactionId = id,
            status = tx.status,
            changes = tx.changes,
            verified = true,
            repeated = true,
        }
    end
    if (undo and tx.status ~= "applied") or (not undo and tx.status ~= "preview") then
        error("Proposal is no longer applicable")
    end
    local work = {}
    for _, change in ipairs(tx.changes) do
        local option = resolve(change.id)
        local expected, desired = change.before, change.after
        if undo then
            expected, desired = change.after, change.before
        end
        check(option, desired)
        if option.read() ~= expected then
            error("Setting changed since this proposal; read settings and prepare a new proposal")
        end
        work[#work + 1] = { option = option, before = expected, after = desired }
    end
    local attempted = 0
    local ok, reason = pcall(function()
        for index, item in ipairs(work) do
            attempted = index
            item.option.write(item.after)
            if item.option.read() ~= item.after then
                error("Setting did not retain the requested value")
            end
        end
    end)
    if not ok then
        local restored = true
        for index = attempted, 1, -1 do
            local item = work[index]
            local good = pcall(item.option.write, item.before)
            local readable, value = pcall(item.option.read)
            if not good or not readable or value ~= item.before then
                restored = false
            end
        end
        tx.status = restored and tx.status or "partial"
        error(
            "Settings change failed; "
                .. (restored and "previous values restored. " or "some values could not be restored. ")
                .. tostring(reason)
        )
    end
    tx.status = undo and "undone" or "applied"
    local reg = registry()
    if reg and reg.NotifyChange then
        for _, app in ipairs(applications()) do
            pcall(reg.NotifyChange, reg, app)
        end
    end
    return { transactionId = id, status = tx.status, changes = tx.changes, verified = true }
end
