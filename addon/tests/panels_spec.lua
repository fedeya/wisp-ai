local helper = require("addon.tests.support")

it(
    "native panels update bag counts locally, preserve unknowns and restore hidden windows",
    function()
        local _ENV = helper.env()
        helper.fixture("addon/tests/wow-ui-stub.lua", _ENV)
        do
            C = { db = {} }
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
        helper.addon("RichUI.lua", _ENV)
        helper.addon("Panels.lua", _ENV)

        panel = {
            id = "materials",
            characterKey = "owner",
            title = "Materials",
            ui = { { id = "count", kind = "stat", label = "Cloth", value = "Loading" } },
            bindings = { { nodeId = "count", source = "item_count", itemId = 2589, target = 10 } },
        }
        local view = C.BoundPanel(panel)
        assert(view.ui[1].value == "3 / 10" and panel.ui[1].value == "Loading")
        C.ReceivePanels({ panel })
        local window
        for _, w in ipairs(UI_TEST.widgets) do
            if w.title and type(w.title) == "table" and w.title:GetText() == "Materials" then
                window = w
            end
        end
        assert(window and window:IsShown())
        local count = #UI_TEST.widgets
        bag = 7
        C.RefreshPanels()
        assert(#UI_TEST.widgets == count, "live updates reuse widgets")
        assert(C.BoundPanel(panel).ui[1].value == "7 / 10")
        window.close.scripts.OnClick()
        assert(not window:IsShown())
        C.ShowPanels()
        assert(window:IsShown())
        C.ReceivePanels(
            { panel },
            { seq = 1, id = "materials", characterKey = "owner", action = "show" }
        )
        window.close.scripts.OnClick()
        C.lastPanelCommand = nil
        C.ReceivePanels(
            { panel },
            { seq = 1, id = "materials", characterKey = "owner", action = "show" }
        )
        assert(
            not window:IsShown(),
            "replayed show commands must not undo a later hide after reload"
        )
        bag = nil
        assert(C.BoundPanel(panel).ui[1].value == "Unavailable")
        C.ReceivePanels({ { id = "foreign", characterKey = "other", title = "Foreign", ui = {} } })
        assert(not window:IsShown())
    end
)
