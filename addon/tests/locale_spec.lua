local helper = require("addon.tests.support")
local LOCALES = helper.LOCALES

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
                local names, wanted = {}, {}
                for name in text:gmatch("{(%w+)}") do
                    names[#names + 1] = name
                end
                for name in english[key]:gmatch("{(%w+)}") do
                    wanted[#wanted + 1] = name
                end
                table.sort(names)
                table.sort(wanted)
                assert.same(wanted, names, locale .. "." .. key .. " named placeholders")
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

        env = buildUI("plPL")
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
                        local radio = { text = text, select = select }
                        function radio.AddInitializer(_, initialize)
                            radio.initialize = initialize
                        end
                        radios[#radios + 1] = radio
                        return radio
                    end,
                })
            end,
        }
        local selector = env.UI_TEST.frames.WispAISettingsPage.language
        assert.equal("English", selector:GetText())
        selector.scripts.OnClick(selector)
        assert.equal(#ns.LOCALE_CHOICES, #radios)
        assert.equal("Español (Latinoamérica)", radios[5].text)
        assert.equal("한국어", radios[10].text)
        radios[5].select()
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

        -- Names in another script get a game font that has it on this client.
        local item = { fontString = env.CreateFrame("Frame"):CreateFontString() }
        radios[10].initialize(item)
        assert.equal("Fonts\\2002.TTF", item.fontString.fontPath)
        item.fontString:SetFontObject({})
        radios[2].initialize(item)
        assert.equal("Fonts\\FRIZQT__.TTF", item.fontString.fontPath)
    end)

    it("uses a game font with the chosen language's script", function()
        for language, face in pairs({
            koKR = "Fonts\\2002.TTF",
            zhCN = "Fonts\\ARKai_T.ttf",
            zhTW = "Fonts\\bLEI00D.ttf",
        }) do
            local env = buildUI("enUS", language)
            local widgets = env.ns.UI.Widgets
            assert.equal(face, widgets.ScriptFace())
            assert.is_false(widgets.InterSupports("Hello"))
            local font = env.CreateFrame("Frame"):CreateFontString()
            widgets.ChatFont(font, env.ns.L["activity.thinking"])
            assert.equal(face, font.fontPath)
        end
        -- The game font already covers the client's own language.
        local env = buildUI("koKR", "koKR")
        assert.is_nil(env.ns.UI.Widgets.ScriptFace())
        -- A Latin or Cyrillic language keeps Inter, except on a CJK/Hangul client,
        -- whose player and zone names need the game font.
        env = buildUI("enUS", "ruRU")
        assert.is_nil(env.ns.UI.Widgets.ScriptFace())
        assert.is_true(env.ns.UI.Widgets.InterSupports("Привет"))
        env = buildUI("koKR", "enUS")
        assert.is_nil(env.ns.UI.Widgets.ScriptFace())
        assert.is_false(env.ns.UI.Widgets.InterSupports("Hello"))
    end)
end)

describe("LocaleText", function()
    it("fills named placeholders in each language's order", function()
        local env = buildUI("enUS")
        local values = { installed = "1.2.10", loaded = "1.2.9" }
        assert.equal(
            "Wisp 1.2.10 is installed (loaded 1.2.9). Type /reload to load the new version.",
            env.ns.LocaleText("notice.addonUpdated", values)
        )
        env.ns.db.language = "ruRU"
        local russian = env.ns.LocaleText("notice.addonUpdated", values)
        assert.is_truthy(russian:find("1.2.10", 1, true))
        assert.is_truthy(russian:find("1.2.9", 1, true))
        assert.is_truthy(russian:find("/reload", 1, true))
        assert.is_falsy(russian:find("{", 1, true))
    end)
end)
