local helper = require("addon.tests.support")

local function setup(_ENV)
    do
        unpack = table.unpack
        C = { db = {}, session = "test" }
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
                ipairs(
                    C.ReadSettings({ provider = "all", sections = { "options" }, limit = 60 }).options
                )
            do
                if o.id == id then
                    return o
                end
            end
        end
    end
    helper.addon("Settings.lua", _ENV)
end

it(
    "live settings discovery handles inherited Ace callbacks, dynamic choices, plugins and read-only options",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        local o = find("ace:Test:enabled")
        assert(o.value == true and o.writable and o.type == "toggle")
        assert(find("ace:Test:mode").options[2].value == "b")
        assert(find("ace:Test:broken"))
        assert(not find("ace:Test:hidden") and not find("ace:Test:reset"))
        assert(not find("ace:Test:group/child").writable)
        blocked = true
        assert(not find("ace:Test:size").writable)
        assert(not find("cvar:locked"))
        local r =
            C.ReadSettings({ sections = { "options" }, provider = "game", ids = { "cvar:locked" } })
        assert(r.options[1].writable == false)
        assert(
            C.ReadSettings({ sections = { "options" }, addon = "Test", limit = 1 }).nextOffset == 1
        )
    end
)

it(
    "settings preview does not mutate, apply verifies values, undo preserves player changes and identity",
    function()
        do
            local _ENV = helper.env()
            setup(_ENV)

            for _, before in ipairs({ true, false }) do
                values.enabled = before
                local r = C.UpdateSettings({
                    operation = "preview",
                    changes = { { id = "ace:Test:enabled", value = not before } },
                })
                assert(
                    C.UpdateSettings({ operation = "apply", transactionId = r.transactionId }).verified
                        and values.enabled == not before
                )
                assert(C.ApplySettings(r.transactionId, true).verified and values.enabled == before)
                assert(C.ApplySettings(r.transactionId, true).repeated)
            end
        end
        do
            local _ENV = helper.env()
            setup(_ENV)

            local r = C.UpdateSettings({
                operation = "preview",
                changes = {
                    { id = "ace:Test:size", value = 1.5 },
                    { id = "cvar:autoLootDefault", value = true },
                },
            })
            assert(values.size == 1 and current.autoLootDefault == "0" and not r.applied)
            local id = r.transactionId
            local a = C.UpdateSettings({ operation = "apply", transactionId = id })
            assert(a.verified and values.size == 1.5 and current.autoLootDefault == "1")
            assert(C.UpdateSettings({ operation = "apply", transactionId = id }).repeated)
            current.autoLootDefault = "0"
            assert(not pcall(C.ApplySettings, id, true))
            assert(values.size == 1.5)
            current.autoLootDefault = "1"
            realm = "Other"
            assert(not pcall(C.ApplySettings, id, true))
            realm = nil
            assert(
                C.ApplySettings(id, true).verified
                    and values.size == 1
                    and current.autoLootDefault == "0"
            )
        end
    end
)

it(
    "stale proposals, range/select/input validation, combat and partial callback failures are handled",
    function()
        local _ENV = helper.env()
        setup(_ENV)

        for _, request in ipairs({
            { id = "ace:Test:size", value = 4 },
            { id = "ace:Test:mode", value = "bad" },
            { id = "ace:Test:text", value = "123" },
            { id = "ace:Test:enabled", value = 1 },
            { id = "ace:Test:reset", value = true },
        }) do
            assert(not pcall(C.UpdateSettings, { operation = "preview", changes = { request } }))
        end
        local r = C.UpdateSettings({
            operation = "preview",
            changes = { { id = "ace:Test:size", value = 1.5 } },
        })
        values.size = 1.2
        assert(
            not pcall(C.UpdateSettings, { operation = "apply", transactionId = r.transactionId })
        )
        values.size = 1
        r = C.UpdateSettings({
            operation = "preview",
            changes = {
                { id = "ace:Test:size", value = 1.5 },
                { id = "ace:Test:broken", value = 2 },
            },
        })
        local ok, err =
            pcall(C.UpdateSettings, { operation = "apply", transactionId = r.transactionId })
        assert(
            not ok
                and tostring(err):find("previous values restored")
                and values.size == 1
                and values.broken == 1
        )
        combat = true
        assert(
            not pcall(C.UpdateSettings, { operation = "apply", transactionId = r.transactionId })
        )
    end
)

it("settings requests are bounded and only preview/apply scalar setting changes", function()
    local _ENV = helper.env()
    setup(_ENV)

    values.enabled = false
    assert(find("ace:Test:enabled").value == false)
    C_CVar.SetCVar = function(k, v)
        current[k] = string.format("%.6f", tonumber(v))
    end
    local r = C.UpdateSettings({
        operation = "preview",
        changes = {
            { id = "cvar:Sound_MusicVolume", value = 0.2 },
        },
    })
    assert(C.UpdateSettings({ operation = "apply", transactionId = r.transactionId }).verified)
    current.Sound_MusicVolume = "0.3"
    assert(not pcall(C.UpdateSettings, { operation = "apply", transactionId = r.transactionId }))
end)
