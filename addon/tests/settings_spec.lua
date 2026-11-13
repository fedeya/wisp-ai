local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    do
        ns = helper.namespace({ db = {}, session = "test" })
        function UnitName()
            return "Mage"
        end
        function GetRealmName()
            return realm or "Realm"
        end
        function time()
            return 100
        end
        function InCombatLockdown()
            return combat or false
        end
        current = { autoLootDefault = "0", Sound_MusicVolume = "0.5", locked = "1" }
        C_CVar = {
            GetCVar = function(k)
                return current[k]
            end,
            GetCVarInfo = function(k)
                if current[k] then
                    return current[k], "0", false, false, k == "locked", false, false
                end
            end,
            SetCVar = function(k, v)
                current[k] = v
            end,
        }
        values = { enabled = true, size = 1, mode = "a", text = "old", broken = 1 }
        handler = {}
        function handler:read(info)
            assert(info[0] == "Test" and info.uiName == "WispAI-1.0")
            return values[info[#info]]
        end
        function handler:write(info, v)
            values[info[#info]] = v
            if info[#info] == "broken" and v == 2 then
                error("callback failed after write")
            end
        end
        function handler:isBlocked()
            return blocked or false
        end
        function handler:choices()
            return { a = "First", b = "Second" }
        end
        root = {
            type = "group",
            handler = handler,
            get = "read",
            set = "write",
            args = {
                enabled = { type = "toggle", name = "Enabled" },
                size = {
                    type = "range",
                    name = "Size",
                    min = 0.5,
                    max = 2,
                    step = 0.1,
                    disabled = "isBlocked",
                },
                mode = { type = "select", name = "Mode", values = "choices" },
                text = { type = "input", name = "Text", pattern = "^%a+$" },
                hidden = { type = "toggle", hidden = true, name = "Secret" },
                reset = {
                    type = "execute",
                    name = "Reset",
                    func = function()
                        error("must never execute")
                    end,
                },
                group = {
                    type = "group",
                    disabled = true,
                    args = { child = { type = "toggle", name = "Blocked" } },
                },
            },
            plugins = {
                plugin = { broken = { type = "range", name = "Broken", min = 0, max = 3 } },
            },
        }
        reg = {
            IterateOptionsTables = function()
                return pairs({ Test = true })
            end,
            GetOptionsTable = function(_, app, ui, name)
                assert(app == "Test" and ui == "dialog" and name == "WispAI-1.0")
                return root
            end,
            NotifyChange = function() end,
        }
        function LibStub(name, silent)
            assert(name == "AceConfigRegistry-3.0")
            return reg
        end
        function find(id)
            for _, o in
                ipairs(ns.Settings.ReadSettings({
                    provider = "all",
                    sections = { "options" },
                    limit = 60,
                }).options)
            do
                if o.id == id then
                    return o
                end
            end
        end
    end
    helper.addon("Settings/Settings.lua", env)
end

local function presetForm(env)
    setup(env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    helper.addon("UI/Widgets.lua", env)
    helper.addon("Actions/Game.lua", env)
    helper.addon("UI/SettingsPresets.lua", env)
    local function find(text)
        for _, widget in ipairs(env.UI_TEST.widgets) do
            if widget:IsVisible() and widget:GetText() == text then
                return widget
            end
        end
    end
    local function click(text)
        local widget = assert(find(text), "Visible control missing: " .. text)
        widget.scripts.OnClick(widget)
    end
    env.ns.UI.SettingsPresets.Show()
    click("New preset")
    local name, entries = nil, {}
    for _, widget in ipairs(env.UI_TEST.widgets) do
        if widget:IsVisible() and widget.kind == "EditBox" then
            if widget.width == 150 then
                name = widget
            else
                entries[#entries + 1] = widget
            end
        elseif widget:IsVisible() and widget.kind == "CheckButton" then
            widget:SetChecked(true)
        end
    end
    assert(name and #entries == 2)
    for _, entry in ipairs(entries) do
        entry:SetText("0.2")
    end
    return name, entries, find, click
end

it(
    "native Save validation preserves all form widgets and permits corrected retry without writes or calls",
    function()
        local env = helper.env()
        local name, entries, find, click = presetForm(env)
        local writes, calls = 0, 0
        env.C_CVar.SetCVar = function()
            writes = writes + 1
        end
        env.ns.Transport.Send = function()
            calls = calls + 1
            error("No transport/model calls")
        end
        local count = #env.UI_TEST.widgets
        entries[2]:SetText("0.7")
        click("Save definition") -- empty name
        assert(find("Save definition"), "Empty-name validation must leave Save retryable")
        assert(find("Use a plain preset name (1–48 bytes), then retry Save."))
        assert(
            name:GetText() == "" and entries[1]:GetText() == "0.2" and entries[2]:GetText() == "0.7"
        )
        assert(not env.ns.db.settingsPresetCounter and #env.UI_TEST.widgets == count)
        name:SetText("Group")
        entries[1]:SetText("typo")
        click("Save definition")
        assert(find("Save definition"), "Invalid desired input must leave Save retryable")
        assert(find("Enter a finite number or true/false for each selected CVar, then retry Save."))
        assert(
            name:GetText() == "Group"
                and entries[1]:GetText() == "typo"
                and entries[2]:GetText() == "0.7"
        )
        for _, widget in ipairs(env.UI_TEST.widgets) do
            if widget:IsVisible() and widget.kind == "CheckButton" then
                assert(widget:GetChecked())
            end
        end
        assert(not env.ns.db.settingsPresetCounter and #env.UI_TEST.widgets == count)
        entries[1]:SetText("0.2")
        click("Save definition")
        assert(find("Group") and not find("Save definition"))
        local saved = env.ns.Settings.ListPresets()
        assert(#saved == 1 and #saved[1].entries == 2 and env.ns.db.settingsPresetCounter == 1)
        assert(writes == 0 and calls == 0)
    end
)

it("retryable Save never reopens identity/session or native-validation failures", function()
    for _, failure in ipairs({ "character", "session", "opaque", "secret", "read-only" }) do
        local env = helper.env()
        local name, _, find, click = presetForm(env)
        local writes, calls = 0, 0
        env.C_CVar.SetCVar = function()
            writes = writes + 1
        end
        env.ns.Transport.Send = function()
            calls = calls + 1
        end
        click("Save definition") -- retryable input error first
        assert(find("Save definition"))
        name:SetText("Group")
        if failure == "character" then
            env.realm = "Other"
        elseif failure == "session" then
            env.ns.session = "other-session"
        elseif failure == "opaque" then
            local opaque = newproxy(true)
            getmetatable(opaque).__tostring = function()
                error("Must not coerce identity")
            end
            env.UnitName = function()
                return opaque
            end
            env.issecretvalue = function(value)
                return rawequal(value, opaque)
            end
        elseif failure == "secret" then
            env.issecretvalue = function(value)
                return value == "Mage"
            end
        else
            env.C_CVar.GetCVarInfo = function()
                return "0", "0", false, false, false, false, true
            end
        end
        click("Save definition")
        assert(not find("Save definition"), failure .. " must fail closed")
        assert(not env.ns.db.settingsPresetCounter and writes == 0 and calls == 0)
    end
end)

it(
    "Apply and Undo conflicts stay fail closed rather than becoming retryable form errors",
    function()
        local env = helper.env()
        local name, _, find, click = presetForm(env)
        name:SetText("Group")
        click("Save definition")
        env.ns.connected = true
        env.ns.capabilities = {
            { id = "tool:update_settings", effective = true },
            { id = "tool:undo_settings", effective = true },
        }
        local writes, calls = 0, 0
        local set = env.C_CVar.SetCVar
        env.C_CVar.SetCVar = function(k, value)
            writes = writes + 1
            set(k, value)
        end
        env.ns.Transport.Send = function()
            calls = calls + 1
        end
        click("Group")
        click("Review changes")
        env.current.Sound_MusicVolume = "0.3"
        click("Apply changes")
        assert(not find("Apply changes") and not find("Undo changes") and writes == 0)
        click("Saved presets")
        click("Group")
        click("Review changes")
        click("Apply changes")
        assert(find("Undo changes") and writes == 2)
        env.current.Sound_MusicVolume = "0.4"
        click("Undo changes")
        assert(
            not find("Undo changes") and not find("Apply changes") and writes == 2 and calls == 0
        )
        assert(env.current.Sound_MusicVolume == "0.4")
    end
)

it(
    "live settings discovery handles inherited Ace callbacks, dynamic choices, plugins and read-only options",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        local o = find("ace:Test:enabled")
        assert(o.value == true and o.writable and o.type == "toggle")
        assert(find("ace:Test:mode").options[2].value == "b")
        assert(find("ace:Test:broken"))
        assert(not find("ace:Test:hidden") and not find("ace:Test:reset"))
        assert(not find("ace:Test:group/child").writable)
        blocked = true
        assert(not find("ace:Test:size").writable)
        assert(not find("cvar:locked"))
        local r = ns.Settings.ReadSettings({
            sections = { "options" },
            provider = "game",
            ids = { "cvar:locked" },
        })
        assert(r.options[1].writable == false)
        assert(
            ns.Settings.ReadSettings({ sections = { "options" }, addon = "Test", limit = 1 }).nextOffset
                == 1
        )
    end
)

it(
    "settings preview does not mutate, apply verifies values, undo preserves player changes and identity",
    function()
        do
            local env = helper.env()
            setfenv(1, env)
            setup(env)

            for _, before in ipairs({ true, false }) do
                values.enabled = before
                local r = ns.Settings.UpdateSettings({
                    operation = "preview",
                    changes = { { id = "ace:Test:enabled", value = not before } },
                })
                assert(ns.Settings.UpdateSettings({
                    operation = "apply",
                    transactionId = r.transactionId,
                }).verified and values.enabled == not before)
                assert(
                    ns.Settings.ApplySettings(r.transactionId, true).verified
                        and values.enabled == before
                )
                assert(ns.Settings.ApplySettings(r.transactionId, true).repeated)
            end
        end
        do
            local env = helper.env()
            setfenv(1, env)
            setup(env)

            local r = ns.Settings.UpdateSettings({
                operation = "preview",
                changes = {
                    { id = "ace:Test:size", value = 1.5 },
                    { id = "cvar:autoLootDefault", value = true },
                },
            })
            assert(values.size == 1 and current.autoLootDefault == "0" and not r.applied)
            local id = r.transactionId
            local a = ns.Settings.UpdateSettings({ operation = "apply", transactionId = id })
            assert(a.verified and values.size == 1.5 and current.autoLootDefault == "1")
            assert(ns.Settings.UpdateSettings({ operation = "apply", transactionId = id }).repeated)
            current.autoLootDefault = "0"
            assert(not pcall(ns.Settings.ApplySettings, id, true))
            assert(values.size == 1.5)
            current.autoLootDefault = "1"
            realm = "Other"
            assert(not pcall(ns.Settings.ApplySettings, id, true))
            realm = nil
            assert(
                ns.Settings.ApplySettings(id, true).verified
                    and values.size == 1
                    and current.autoLootDefault == "0"
            )
        end
    end
)

it(
    "stale proposals, range/select/input validation, combat and partial callback failures are handled",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)

        for _, request in ipairs({
            { id = "ace:Test:size", value = 4 },
            { id = "ace:Test:mode", value = "bad" },
            { id = "ace:Test:text", value = "123" },
            { id = "ace:Test:enabled", value = 1 },
            { id = "ace:Test:reset", value = true },
        }) do
            assert(
                not pcall(
                    ns.Settings.UpdateSettings,
                    { operation = "preview", changes = { request } }
                )
            )
        end
        local r = ns.Settings.UpdateSettings({
            operation = "preview",
            changes = { { id = "ace:Test:size", value = 1.5 } },
        })
        values.size = 1.2
        assert(
            not pcall(
                ns.Settings.UpdateSettings,
                { operation = "apply", transactionId = r.transactionId }
            )
        )
        values.size = 1
        r = ns.Settings.UpdateSettings({
            operation = "preview",
            changes = {
                { id = "ace:Test:size", value = 1.5 },
                { id = "ace:Test:broken", value = 2 },
            },
        })
        local ok, err = pcall(
            ns.Settings.UpdateSettings,
            { operation = "apply", transactionId = r.transactionId }
        )
        assert(
            not ok
                and tostring(err):find("previous values restored")
                and values.size == 1
                and values.broken == 1
        )
        combat = true
        assert(
            not pcall(
                ns.Settings.UpdateSettings,
                { operation = "apply", transactionId = r.transactionId }
            )
        )
    end
)

it("settings requests are bounded and only preview/apply scalar setting changes", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)

    values.enabled = false
    assert(find("ace:Test:enabled").value == false)
    C_CVar.SetCVar = function(k, v)
        current[k] = string.format("%.6f", tonumber(v))
    end
    local r = ns.Settings.UpdateSettings({
        operation = "preview",
        changes = {
            { id = "cvar:Sound_MusicVolume", value = 0.2 },
        },
    })
    assert(
        ns.Settings.UpdateSettings({ operation = "apply", transactionId = r.transactionId }).verified
    )
    current.Sound_MusicVolume = "0.3"
    assert(
        not pcall(
            ns.Settings.UpdateSettings,
            { operation = "apply", transactionId = r.transactionId }
        )
    )
end)

it(
    "saved desired settings create a fresh preview after reload, never replaying a transaction",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        -- A persisted definition, not a persisted before/after transaction.
        ns.db.settingsPresets = {
            ["test-preset-1"] = {
                id = "test-preset-1",
                owner = "Realm:Mage",
                name = "Group",
                revision = 1,
                entries = { { id = "cvar:Sound_MusicVolume", value = "0.2" } },
            },
        }
        helper.addon("Settings/Settings.lua", env)
        current.Sound_MusicVolume = "0.3"
        local writes = 0
        C_CVar.SetCVar = function(k, v)
            writes = writes + 1
            current[k] = v
        end
        local preview = ns.Settings.UpdateSettings({
            operation = "preview",
            presetId = "test-preset-1",
            revision = 1,
        })
        assert(preview.changes[1].before == "0.3" and preview.changes[1].after == "0.2")
        assert(writes == 0)
        assert(ns.Settings.UpdateSettings({
            operation = "apply",
            transactionId = preview.transactionId,
        }).verified)
        assert(current.Sound_MusicVolume == "0.2" and writes == 1)
        assert(ns.Settings.ApplySettings(preview.transactionId, true).verified)
        assert(current.Sound_MusicVolume == "0.3" and writes == 2)
        current.Sound_MusicVolume = "0.4"
        local later = ns.Settings.UpdateSettings({
            operation = "preview",
            presetId = "test-preset-1",
            revision = 1,
        })
        assert(later.transactionId ~= preview.transactionId and later.changes[1].before == "0.4")
    end
)

it(
    "saves bounded owner-owned desired definitions, lists after reload and rejects invalid values",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        local writes = 0
        C_CVar.SetCVar = function()
            writes = writes + 1
        end
        local id = ns.Settings.SavePreset("Group", {
            { id = "cvar:Sound_MusicVolume", value = 0.2 },
            { id = "cvar:autoLootDefault", value = true },
        })
        assert(writes == 0 and not ns.db.settingsTransactions)
        -- WoW restores WispAIDB before loading the addon; retain that store across a new namespace.
        local saved = ns.db
        ns = helper.namespace({ db = saved, session = "restarted" })
        helper.addon("Settings/Settings.lua", env)
        local items = ns.Settings.ListPresets()
        assert(#items == 1 and items[1].id == id and items[1].entries[1].value == "0.2")
        items[1].entries[1].value = "0.9"
        assert(ns.Settings.ListPresets()[1].entries[1].value == "0.2")
        saved.settingsPresets[id].entries[1].value = "run()"
        assert(not pcall(ns.Settings.ListPresets))
        saved.settingsPresets[id].entries[1].value = "0.2"
        realm = "Other"
        assert(#ns.Settings.ListPresets() == 0)
        assert(
            not pcall(
                ns.Settings.UpdateSettings,
                { operation = "preview", presetId = id, revision = 1 }
            )
        )
        realm = nil
        assert(
            not pcall(
                ns.Settings.SavePreset,
                "Group",
                { { id = "cvar:autoLootDefault", value = false } }
            )
        )
        for _, value in ipairs({ "0.2", "run()", 0 / 0, math.huge, -math.huge }) do
            assert(
                not pcall(
                    ns.Settings.SavePreset,
                    "Invalid",
                    { { id = "cvar:Sound_MusicVolume", value = value } }
                )
            )
        end
        current.text = "arbitrary"
        for _, entry in ipairs({
            { id = "cvar:text", value = 1 },
            { id = "cvar:locked", value = 1 },
            { id = "cvar:missing", value = 1 },
            { id = "ace:Test:enabled", value = true },
            { id = "cvar:sound_musicvolume", value = 0.2 },
        }) do
            assert(not pcall(ns.Settings.SavePreset, "Invalid", { entry }))
        end
        assert(not pcall(ns.Settings.SavePreset, "", {}))
        assert(
            not pcall(
                ns.Settings.SavePreset,
                string.rep("x", 49),
                { { id = "cvar:autoLootDefault", value = true } }
            )
        )
        local many = {}
        for i = 1, 13 do
            many[i] = { id = "cvar:autoLootDefault", value = true }
        end
        assert(not pcall(ns.Settings.SavePreset, "Too many", many))
        for i = 2, 30 do
            ns.Settings.SavePreset(
                "Preset " .. i,
                { { id = "cvar:autoLootDefault", value = true } }
            )
        end
        assert(
            not pcall(
                ns.Settings.SavePreset,
                "Overflow",
                { { id = "cvar:autoLootDefault", value = true } }
            )
        )
        assert(writes == 0)
    end
)

it(
    "preset rediscovery fails as a whole and existing apply/undo guards remain authoritative",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        local writes = 0
        local set = C_CVar.SetCVar
        C_CVar.SetCVar = function(k, v)
            writes = writes + 1
            set(k, v)
        end
        local id = ns.Settings.SavePreset("Group", {
            { id = "cvar:Sound_MusicVolume", value = 0.2 },
            { id = "cvar:autoLootDefault", value = true },
        })
        local function preview(revision)
            return ns.Settings.UpdateSettings({
                operation = "preview",
                presetId = id,
                revision = revision or 1,
            })
        end
        assert(not pcall(preview, 2))
        current.autoLootDefault = nil
        assert(not pcall(preview) and not ns.db.settingsTransactions)
        current.autoLootDefault = "text"
        assert(not pcall(preview))
        current.autoLootDefault = "0"
        local info = C_CVar.GetCVarInfo
        C_CVar.GetCVarInfo = function(k)
            return current[k], "0", false, false, false, false, true
        end
        assert(not pcall(preview))
        C_CVar.GetCVarInfo = info
        current.Sound_MusicVolume = "0.3"
        local p = preview()
        current.autoLootDefault = "1"
        assert(not pcall(ns.Settings.ApplySettings, p.transactionId, false) and writes == 0)
        current.autoLootDefault = "0"
        combat = true
        assert(not pcall(preview))
        assert(not pcall(ns.Settings.ApplySettings, p.transactionId, false) and writes == 0)
        combat = false
        assert(ns.Settings.ApplySettings(p.transactionId, false).verified and writes == 2)
        current.autoLootDefault = "0"
        assert(not pcall(ns.Settings.ApplySettings, p.transactionId, true) and writes == 2)
        assert(current.Sound_MusicVolume == "0.2")
    end
)

it(
    "native preset controls save/select/review locally and gate explicit existing Apply/Undo",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        helper.addon("UI/Widgets.lua", env)
        helper.addon("Actions/Game.lua", env)
        helper.addon("UI/SettingsPresets.lua", env)
        local writes, modelCalls = 0, 0
        ns.Transport.Send = function()
            modelCalls = modelCalls + 1
            error("No transport/model calls allowed")
        end
        local set = C_CVar.SetCVar
        C_CVar.SetCVar = function(k, v)
            writes = writes + 1
            set(k, v)
        end
        local function findWidget(text)
            for _, w in ipairs(UI_TEST.widgets) do
                if w:IsVisible() and w:GetText() == text then
                    return w
                end
            end
            error("Visible widget not found: " .. text)
        end
        local function click(text)
            local w = findWidget(text)
            w.scripts.OnClick(w)
        end
        ns.UI.SettingsPresets.Show()
        click("New preset")
        local name, desired, check
        for _, w in ipairs(UI_TEST.widgets) do
            if w:IsVisible() and w.kind == "EditBox" and w.width == 150 then
                name = w
            end
            if w:IsVisible() and w:GetText() == "Sound_MusicVolume\nCurrent 0.5" then
                local _, _, _, _, y = w:GetPoint()
                for _, field in ipairs(UI_TEST.widgets) do
                    if field.parent == w.parent then
                        local _, _, _, _, fy = field:GetPoint()
                        if field.kind == "CheckButton" and fy == y then
                            check = field
                        end
                        if field.kind == "EditBox" and fy == y - 5 then
                            desired = field
                        end
                    end
                end
            end
        end
        assert(name and desired and check)
        name:SetText("Group")
        desired:SetText("0.2")
        check:SetChecked(true)
        click("Save definition")
        assert(writes == 0 and modelCalls == 0)
        click("Group")
        findWidget("cvar:Sound_MusicVolume = 0.2")
        current.Sound_MusicVolume = "0.3"
        click("Review changes")
        findWidget("cvar:Sound_MusicVolume\nAt review 0.3  →  Desired 0.2")
        assert(writes == 0 and modelCalls == 0)
        click("Apply changes") -- capabilities absent: fail closed
        assert(writes == 0)
        ns.capabilities = {
            { id = "tool:update_settings", enabled = true, effective = true },
            { id = "tool:undo_settings", enabled = true, effective = true },
        }
        ns.connected = true
        click("Saved presets")
        click("Group")
        click("Review changes")
        click("Apply changes")
        assert(writes == 1 and current.Sound_MusicVolume == "0.2")
        findWidget("cvar:Sound_MusicVolume\nAt review 0.3  →  Desired 0.2")
        click("Undo changes")
        assert(writes == 2 and current.Sound_MusicVolume == "0.3" and modelCalls == 0)
        findWidget("cvar:Sound_MusicVolume\nAt review 0.3  →  Desired 0.2")
        local widgetCount = #UI_TEST.widgets
        for _ = 1, 5 do
            click("Saved presets")
            click("Group")
            click("Review changes")
        end
        assert(#UI_TEST.widgets == widgetCount)
        ns.capabilities[1].effective = false -- configured on, but unavailable/parent disabled
        click("Apply changes")
        assert(writes == 2)
        ns.capabilities[1].effective = true
        click("Saved presets")
        click("Group")
        click("Review changes")
        ns.capabilityPending = { ["tool:update_settings"] = { enabled = false } }
        click("Apply changes")
        assert(writes == 2)
        ns.capabilityPending = {}
        click("Saved presets")
        click("Group")
        click("Review changes")
        ns.connected = false
        click("Apply changes")
        assert(writes == 2)
        ns.connected = true
        click("Saved presets")
        click("Group")
        click("Review changes")
        realm = "Other"
        click("Apply changes")
        assert(writes == 2)
    end
)

it(
    "native preset deletion requires confirmation and never changes game values or transaction history",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        helper.addon("UI/Widgets.lua", env)
        helper.addon("UI/SettingsPresets.lua", env)
        local writes, sends = 0, 0
        ns.Transport.Send = function()
            sends = sends + 1
        end
        local id =
            ns.Settings.SavePreset("Group", { { id = "cvar:Sound_MusicVolume", value = 0.2 } })
        local preview =
            ns.Settings.UpdateSettings({ operation = "preview", presetId = id, revision = 1 })
        local transaction = ns.db.settingsTransactions[preview.transactionId]
        assert(ns.Settings.ApplySettings(preview.transactionId, false).verified)
        C_CVar.SetCVar = function()
            writes = writes + 1
        end
        local function click(text)
            for _, w in ipairs(UI_TEST.widgets) do
                if w:IsVisible() and w:GetText() == text then
                    w.scripts.OnClick(w)
                    return
                end
            end
            error("Visible button not found: " .. text)
        end
        ns.UI.SettingsPresets.Show()
        click("Group")
        click("Delete preset")
        assert(#ns.Settings.ListPresets() == 1 and writes == 0)
        click("Cancel")
        assert(#ns.Settings.ListPresets() == 1)
        click("Delete preset")
        ns.db.settingsPresets[id].revision = 2
        click("Delete definition")
        assert(ns.db.settingsPresets[id] and writes == 0) -- stale selection cannot delete
        ns.db.settingsPresets[id].revision = 1
        click("Saved presets")
        click("Group")
        click("Delete preset")
        realm = "Other"
        click("Delete definition")
        assert(ns.db.settingsPresets[id] and writes == 0)
        realm = nil
        assert(not pcall(ns.Settings.DeletePreset, id, 2))
        realm = "Other"
        assert(not pcall(ns.Settings.DeletePreset, id, 1))
        realm = nil
        click("Saved presets")
        click("Group")
        click("Delete preset")
        click("Delete definition")
        assert(#ns.Settings.ListPresets() == 0)
        assert(ns.db.settingsTransactions[preview.transactionId] == transaction)
        assert(
            current.Sound_MusicVolume == "0.2"
                and transaction.status == "applied"
                and writes == 0
                and sends == 0
        )
        assert(not pcall(ns.Settings.DeletePreset, id, 1))
    end
)

it(
    "preset ownership rejects secret or unreadable native identity before comparison or persistence",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        local id =
            ns.Settings.SavePreset("Group", { { id = "cvar:Sound_MusicVolume", value = 0.2 } })
        local entry = { { id = "cvar:Sound_MusicVolume", value = 0.1 } }
        local originalName, originalRealm = UnitName, GetRealmName
        local opaque = newproxy(true)
        local touches = 0
        getmetatable(opaque).__tostring = function()
            touches = touches + 1
            error("opaque identity")
        end
        getmetatable(opaque).__concat = function()
            touches = touches + 1
            error("opaque identity")
        end
        issecretvalue = function(value)
            return rawequal(value, opaque) or value == "secret-name" or value == "secret-realm"
        end
        for _, kind in ipairs({ "name", "realm" }) do
            for _, value in ipairs({ opaque, "secret-" .. kind, "" }) do
                UnitName = kind == "name"
                        and function()
                            return value
                        end
                    or originalName
                GetRealmName = kind == "realm"
                        and function()
                            return value
                        end
                    or originalRealm
                assert(not pcall(ns.Settings.SavePreset, "Invalid", entry))
                assert(not pcall(ns.Settings.ListPresets))
                assert(
                    not pcall(
                        ns.Settings.UpdateSettings,
                        { operation = "preview", presetId = id, revision = 1 }
                    )
                )
                assert(not pcall(ns.Settings.DeletePreset, id, 1))
                assert(
                    ns.db.settingsPresets[id]
                        and ns.db.settingsPresetCounter == 1
                        and not ns.db.settingsTransactions
                )
            end
        end
        UnitName = function()
            error("unreadable native identity")
        end
        GetRealmName = originalRealm
        assert(not pcall(ns.Settings.SavePreset, "Invalid", entry))
        assert(touches == 0)
        UnitName = originalName
        assert(#ns.Settings.ListPresets() == 1)
        canaccessvalue = function()
            return false
        end
        assert(not pcall(ns.Settings.SavePreset, "Unreadable", entry))
        assert(not pcall(ns.Settings.DeletePreset, id, 1))
        canaccessvalue = nil
        assert(#ns.Settings.ListPresets() == 1)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        helper.addon("UI/Widgets.lua", env)
        helper.addon("UI/SettingsPresets.lua", env)
        UnitName = function()
            return "secret-name"
        end
        assert(pcall(ns.UI.SettingsPresets.Show))
        local unavailable = false
        for _, widget in ipairs(UI_TEST.widgets) do
            if
                widget:IsVisible()
                and widget:GetText()
                    == "Active character identity is unavailable. Reopen presets when readable."
            then
                unavailable = true
            end
        end
        assert(unavailable and ns.db.settingsPresetCounter == 1 and touches == 0)
    end
)

it(
    "native preset picker reports truncated discovery rather than a complete game configuration",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        helper.addon("UI/Widgets.lua", env)
        helper.addon("UI/SettingsPresets.lua", env)
        C_CVar.GetCVar = function()
            return "0"
        end
        assert(ns.Settings.ReadSettings({ provider = "game", limit = 60 }).nextOffset == 60)
        ns.UI.SettingsPresets.Show()
        for _, widget in ipairs(UI_TEST.widgets) do
            if widget:IsVisible() and widget:GetText() == "New preset" then
                widget.scripts.OnClick(widget)
                break
            end
        end
        local notice = false
        for _, widget in ipairs(UI_TEST.widgets) do
            if
                widget:IsVisible()
                and widget:GetText()
                    == "Select 1–12 from first 60 targets; not all game settings. Save makes no game writes."
            then
                notice = true
            end
        end
        assert(notice and not ns.db.settingsTransactions and not ns.db.settingsPresetCounter)
    end
)
