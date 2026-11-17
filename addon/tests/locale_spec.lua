local helper = require("addon.tests.support")
local LOCALES = { "enUS", "esES", "esMX" }

local function buildUI(gameLocale, language)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    GetLocale = function()
        return gameLocale
    end
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = {}, language = language },
        connected = true,
        session = "test",
        chats = {},
        pendingChats = {},
        pendingMessages = {},
        workStarted = {},
    })
    function ns.Transport.Send() end
    helper.addon("Chat/State.lua", env)
    helper.addon("UI/Window.lua", env)
    ns.UI.BuildUI()
    return env
end

describe("locales", function()
    it("loads every locale file after the lookup in the manifest", function()
        local manifest = {}
        for line in io.lines("addon/WispAI/WispAI.toc") do
            manifest[#manifest + 1] = line:gsub("\\", "/")
        end
        local position = {}
        for index, line in ipairs(manifest) do
            position[line] = index
        end
        for _, locale in ipairs(LOCALES) do
            local file = "Locales/" .. locale .. ".lua"
            assert.is_truthy(position[file], file .. " is missing from the manifest")
            assert.is_true(position[file] > position["Locale.lua"])
            assert.is_true(position[file] < position["UI/Widgets.lua"])
        end
    end)

    it("only defines keys that exist in English", function()
        local ns = buildUI("enUS").ns
        local english = ns.Locales.enUS
        for _, locale in ipairs(LOCALES) do
            local strings = assert(ns.Locales[locale], locale .. " did not load")
            for key, text in pairs(strings) do
                assert.is_string(english[key], locale .. " has a key English lacks: " .. key)
                assert.is_string(text, locale .. "." .. key)
                local _, placeholders = english[key]:gsub("%%[%a%%]", "")
                local _, translated = text:gsub("%%[%a%%]", "")
                assert.equal(placeholders, translated, locale .. "." .. key .. " placeholders")
            end
        end
    end)

    it("shows the UI in the game's Spanish and falls back to English", function()
        local env = buildUI("esES")
        local L = env.ns.L
        assert.equal("Nuevo chat", L["sidebar.newChat"])
        assert.equal("Contexto ~24%", L["context.percent"]:format(24))
        assert.equal("Subida de nivel", env.ns.UI.Routines.EventLabel("level_up"))
        assert.equal(
            "¿Qué puedes hacer?",
            env.UI_TEST.frames.WispAIChatPlaceholder.starter:GetText()
        )
        env.ns.Locales.esES["sidebar.newChat"] = nil
        assert.equal("New chat", L["sidebar.newChat"])
        assert.equal("no.such.key", L["no.such.key"])

        env = buildUI("esMX")
        assert.equal("¿Volviste por más, %s?", env.ns.L["greeting.backForMore"])
        assert.equal("Configuración", env.ns.L["settings.title"])

        env = buildUI("frFR")
        assert.equal("New chat", env.ns.L["sidebar.newChat"])
    end)

    it("lets the Language setting override the game and asks to reload", function()
        local env = buildUI("esES", "enUS")
        local ns = env.ns
        assert.equal("New chat", ns.L["sidebar.newChat"])
        assert.equal("enUS", ns.ActiveLocale())

        local radios = {}
        env.MenuUtil = {
            CreateContextMenu = function(owner, generate)
                generate(owner, {
                    CreateRadio = function(_, text, _, select)
                        radios[#radios + 1] = { text = text, select = select }
                    end,
                })
            end,
        }
        local selector = env.UI_TEST.frames.WispAISettingsPage.language
        assert.equal("English", selector:GetText())
        selector.scripts.OnClick(selector)
        assert.equal(4, #radios)
        assert.equal("Español (Latinoamérica)", radios[4].text)
        radios[4].select()
        assert.equal("esMX", ns.db.language)
        assert.equal("Español (Latinoamérica)", selector:GetText())
        assert.equal("WISPAI_RELOAD_LANGUAGE", env.UI_TEST.popup.id)
        local reloaded = false
        env.ReloadUI = function()
            reloaded = true
        end
        env.StaticPopupDialogs.WISPAI_RELOAD_LANGUAGE.OnAccept()
        assert.is_true(reloaded)

        radios[1].select()
        assert.equal("auto", ns.db.language)
        assert.equal("esES", ns.ActiveLocale())
    end)
end)
