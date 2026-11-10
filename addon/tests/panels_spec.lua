local helper = require("addon.tests.support")

it(
    "native panels update bag counts locally, preserve unknowns and restore hidden windows",
    function()
        local env = helper.env()
        setfenv(1, env)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        do
            ns = helper.namespace({ db = {} })
            function UnitName()
                return "Mage"
            end
            function GetRealmName()
                return "Realm"
            end
            C_EncodingUtil = {
                DeserializeJSON = function(key)
                    return { "Forever", key == "owner" and "Realm" or "Other", "Mage" }
                end,
            }
            bag = 3
            C_Item.GetItemCount = function(id, bank)
                assert(id == 2589 and bank == false)
                return bag
            end
            function UnitLevel()
                return 11
            end
            function GetMoney()
                return 12345
            end
        end
        helper.addon("UI/RichUI.lua", env)
        helper.addon("Panels/Panels.lua", env)

        panel = {
            id = "materials",
            characterKey = "owner",
            title = "Materials",
            ui = { { id = "count", kind = "stat", label = "Cloth", value = "Loading" } },
            bindings = { { nodeId = "count", source = "item_count", itemId = 2589, target = 10 } },
        }
        local view = ns.Panels.BoundPanel(panel)
        assert(view.ui[1].value == "3 / 10" and panel.ui[1].value == "Loading")
        ns.Panels.ReceivePanels({ panel })
        local window
        for _, w in ipairs(UI_TEST.widgets) do
            if w.title and type(w.title) == "table" and w.title:GetText() == "Materials" then
                window = w
            end
        end
        assert(window and window:IsShown())
        local count = #UI_TEST.widgets
        bag = 7
        ns.Panels.RefreshPanels()
        assert(#UI_TEST.widgets == count, "live updates reuse widgets")
        assert(ns.Panels.BoundPanel(panel).ui[1].value == "7 / 10")
        window.close.scripts.OnClick()
        assert(not window:IsShown())
        ns.Panels.ShowPanels()
        assert(window:IsShown())
        ns.Panels.ReceivePanels(
            { panel },
            { seq = 1, id = "materials", characterKey = "owner", action = "show" }
        )
        window.close.scripts.OnClick()
        ns.lastPanelCommand = nil
        ns.Panels.ReceivePanels(
            { panel },
            { seq = 1, id = "materials", characterKey = "owner", action = "show" }
        )
        assert(
            not window:IsShown(),
            "replayed show commands must not undo a later hide after reload"
        )
        bag = nil
        assert(ns.Panels.BoundPanel(panel).ui[1].value == "Unavailable")
        ns.Panels.ReceivePanels({
            { id = "foreign", characterKey = "other", title = "Foreign", ui = {} },
        })
        assert(not window:IsShown())
    end
)

it(
    "updates pending panel labels after syntax completion without invalidating settled labels",
    function()
        local env = helper.env()
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        env.ns = helper.namespace({ db = {}, Markdown = { Cache = { revision = 0 } } })
        env.UnitName = function()
            return "Mage"
        end
        env.GetRealmName = function()
            return "Realm"
        end
        env.C_EncodingUtil = {
            DeserializeJSON = function()
                return { "Forever", "Realm", "Mage" }
            end,
        }
        local ns, ready, calls, settledCalls = env.ns, false, 0, 0
        local source = "**" .. string.rep("Long label ", 60) .. "**"
        ns.UI.FormatText = function(value)
            if value == source then
                calls = calls + 1
                return ready and "|cffe3c77eCompleted label|r" or source, not ready
            elseif value == "Settled label" then
                settledCalls = settledCalls + 1
            end
            return tostring(value)
        end
        helper.addon("UI/RichUI.lua", env)
        helper.addon("Panels/Panels.lua", env)
        ns.Panels.ReceivePanels({
            {
                id = "async",
                characterKey = "owner",
                title = "Async panel",
                ui = { { id = "label", kind = "text", text = source } },
            },
            {
                id = "settled",
                characterKey = "owner",
                title = "Settled panel",
                ui = { { id = "label", kind = "text", text = "Settled label" } },
            },
        })
        local window, settledWindow
        for _, widget in ipairs(env.UI_TEST.widgets) do
            if
                widget.title
                and type(widget.title) == "table"
                and widget.title:GetText() == "Async panel"
            then
                window = widget
            elseif
                widget.title
                and type(widget.title) == "table"
                and widget.title:GetText() == "Settled panel"
            then
                settledWindow = widget
            end
        end
        assert.is_truthy(window)
        assert.is_truthy(settledWindow)
        assert.equal(source, window.host.widgets.label.title:GetText())
        assert.is_true(window.inlineMarkdownPending)
        assert.is_false(settledWindow.inlineMarkdownPending)
        assert.equal(1, calls)
        assert.equal(1, settledCalls)
        ns.Panels.RefreshPanels()
        assert.equal(1, calls, "unchanged pending revisions do not render repeatedly")
        assert.equal(1, settledCalls)
        ready, ns.Markdown.Cache.revision = true, 1
        ns.Panels.RefreshPanels()
        assert.equal("|cffe3c77eCompleted label|r", window.host.widgets.label.title:GetText())
        assert.is_false(window.inlineMarkdownPending)
        assert.equal(2, calls)
        assert.equal(1, settledCalls, "pending state does not leak between panels")
        ns.Markdown.Cache.revision = 2
        ns.Panels.RefreshPanels()
        assert.equal(2, calls, "another document's completion does not invalidate a settled panel")
        assert.equal(1, settledCalls)
    end
)
