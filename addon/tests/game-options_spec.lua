local helper = require("addon.tests.support")

local function load(prepare)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    ns = helper.namespace({ db = { language = "esMX" } })
    -- Buttons from UIPanelButtonTemplate carry a font string for their label.
    local createFrame = CreateFrame
    function CreateFrame(kind, name, parent, template)
        local frame = createFrame(kind, name, parent, template)
        if kind == "Button" then
            local text = frame:CreateFontString()
            function frame:GetFontString()
                return text
            end
        end
        return frame
    end
    GameFontHighlight = {
        GetFont = function()
            return [[Fonts\FRIZQT__.TTF]], 12, ""
        end,
    }
    GameFontNormal = GameFontHighlight
    prepare(env)
    helper.addon("UI/Widgets.lua", env)
    helper.addon("UI/GameOptions.lua", env)
    return env
end

describe("game options", function()
    it("registers Wisp under AddOns and opens Wisp's own Settings", function()
        local registered, added, shown, hidden = nil, nil, nil, {}
        local env = load(function(env)
            env.Settings = {
                RegisterCanvasLayoutCategory = function(frame, name)
                    registered = { frame = frame, name = name }
                    return { id = name }
                end,
                RegisterAddOnCategory = function(category)
                    added = category
                end,
            }
            env.SettingsPanel = {
                IsShown = function()
                    return true
                end,
            }
            env.HideUIPanel = function(frame)
                hidden[#hidden + 1] = frame
            end
            env.ns.UI.ShowSettings = function(page)
                shown = page
            end
        end)
        local page = env.ns.UI.GameOptions.Register()
        assert.are.equal(page, registered.frame)
        assert.are.equal("Wisp AI", registered.name)
        assert.are.same({ id = "Wisp AI" }, added)
        assert.are.equal(
            page,
            env.ns.UI.GameOptions.Register(),
            "registering twice reuses the page"
        )

        local open = env.UI_TEST.frames.WispAIGameOptionsOpen
        assert.are.equal("Abrir configuración de Wisp", open:GetText())
        open.scripts.OnClick(open)
        assert.are.same({ env.SettingsPanel }, hidden, "the game's options close behind Wisp")
        assert.are.equal("general", shown)
    end)

    it("falls back to Interface Options on clients without the Settings API", function()
        local added
        local env = load(function(env)
            env.Settings = nil
            env.InterfaceOptions_AddCategory = function(frame)
                added = frame
            end
        end)
        local page = env.ns.UI.GameOptions.Register()
        assert.are.equal(page, added)
        assert.are.equal("Wisp AI", page.name)
    end)

    it("draws the text in the chosen language's script when the game runs in another", function()
        local env = load(function(env)
            env.GetLocale = function()
                return "enUS"
            end
            env.InterfaceOptions_AddCategory = function() end
        end)
        env.ns.db.language = "koKR"
        local page = env.ns.UI.GameOptions.Register()
        local open = env.UI_TEST.frames.WispAIGameOptionsOpen
        local description
        for _, widget in ipairs(env.UI_TEST.widgets) do
            if
                widget.kind == "FontString"
                and widget.text == env.ns.L["gameOptions.description"]
            then
                description = widget
            end
        end
        assert.are.equal([[Fonts\2002.TTF]], (description:GetFont()))
        assert.are.equal([[Fonts\2002.TTF]], (open:GetFontString():GetFont()))

        env.ns.db.language = "enUS"
        page.scripts.OnShow(page)
        assert.are.equal(
            [[Fonts\FRIZQT__.TTF]],
            (description:GetFont()),
            "English goes back to the game face"
        )
        assert.are.equal([[Fonts\FRIZQT__.TTF]], (open:GetFontString():GetFont()))
    end)
end)
