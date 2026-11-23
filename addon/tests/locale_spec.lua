local helper = require("addon.tests.support")
local LOCALES = helper.LOCALES

local function buildUI(gameLocale, language, prepare, chatLanguage)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    GetLocale = function()
        return gameLocale
    end
    if prepare then
        prepare(env)
    end
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = {}, language = language, chatLanguage = chatLanguage },
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
        item = { fontString = env.CreateFrame("Frame"):CreateFontString() }
        item.fontString:SetFontObject({})
        radios[2].initialize(item)
        assert.equal("Fonts\\FRIZQT__.TTF", item.fontString.fontPath)
    end)

    it("offers and sends suggestions in the chat language", function()
        local env = buildUI("enUS", "enUS", nil, "esES")
        local ns = env.ns
        assert.equal("esES", ns.ChatLocale())
        assert.equal("New chat", ns.L["sidebar.newChat"])
        assert.equal("Nuevo chat", ns.ChatL["sidebar.newChat"])
        local starter = env.UI_TEST.frames.WispAIChatPlaceholder.starter
        assert.equal("¿Qué puedes hacer?", starter:GetText())
        local sent
        function ns.Transport.Send(message)
            sent = message
        end
        starter.scripts.OnClick(starter)
        assert.equal("say", sent.type)
        assert.equal("¿Qué puedes hacer?", sent.text)

        -- Unset, or "interface", the chat follows the UI language.
        ns.db.chatLanguage = "interface"
        assert.equal("enUS", ns.ChatLocale())
        assert.equal("New chat", ns.ChatL["sidebar.newChat"])
        env = buildUI("esES")
        assert.equal("esES", env.ns.ChatLocale())
        assert.equal("¿Qué puedes hacer?", env.ns.ChatL["suggestion.whatCanYouDo"])
    end)

    it("lets the Chat language setting differ from the UI and asks to reload", function()
        local env = buildUI("enUS", "esES")
        local ns = env.ns
        local radios = {}
        env.MenuUtil = {
            CreateContextMenu = function(owner, generate)
                generate(owner, {
                    CreateRadio = function(_, text, checked, select)
                        local radio = { text = text, checked = checked, select = select }
                        function radio.AddInitializer() end
                        radios[#radios + 1] = radio
                        return radio
                    end,
                })
            end,
        }
        local language = env.UI_TEST.frames.WispAISettingsPage.language
        assert.equal("Español (España)", language:GetText())
        local selector = env.UI_TEST.frames.WispAISettingsPage.chatLanguage
        assert.equal("Igual que la interfaz", selector:GetText())
        selector.scripts.OnClick(selector)
        assert.equal(#ns.CHAT_LOCALE_CHOICES, #radios)
        assert.equal(#ns.LOCALE_CHOICES, #ns.CHAT_LOCALE_CHOICES)
        assert.equal("Igual que la interfaz", radios[1].text)
        assert.is_true(radios[1].checked())
        assert.equal("English", radios[2].text)
        radios[2].select()
        assert.equal("enUS", ns.db.chatLanguage)
        assert.equal("esES", ns.db.language)
        assert.equal("English", selector:GetText())
        assert.equal("WISPAI_RELOAD_LANGUAGE", env.UI_TEST.popup.id)
        assert.equal("Nuevo chat", ns.L["sidebar.newChat"])
        assert.equal("What can you do?", ns.ChatL["suggestion.whatCanYouDo"])
    end)

    it("draws a CJK chat language in its script face under a Latin UI", function()
        local env = buildUI("enUS", "enUS", nil, "zhCN")
        local widgets = env.ns.UI.Widgets
        -- UI chrome keeps Inter; the draft and Chinese chat text get ARKai.
        assert.is_nil(widgets.ScriptFace())
        assert.is_true(widgets.InterSupports(""))
        local font = env.CreateFrame("Frame"):CreateFontString()
        widgets.ChatFont(font, "")
        assert.equal("Fonts\\ARKai_T.ttf", font.fontPath)
        widgets.ChatFont(font, "升级循环")
        assert.equal("Fonts\\ARKai_T.ttf", font.fontPath)
        widgets.ChatFont(font, "Level up")
        assert.equal("Interface\\AddOns\\WispAI\\Fonts\\Inter-Medium.ttf", font.fontPath)

        -- Under a Chinese UI with Korean chat, each script takes its own face.
        env = buildUI("enUS", "zhCN", nil, "koKR")
        widgets = env.ns.UI.Widgets
        font = env.CreateFrame("Frame"):CreateFontString()
        widgets.ChatFont(font, "레벨업")
        assert.equal("Fonts\\2002.TTF", font.fontPath)
        widgets.ChatFont(font, "升级循环")
        assert.equal("Fonts\\ARKai_T.ttf", font.fontPath)
        widgets.ChatFont(font, "")
        assert.equal("Fonts\\2002.TTF", font.fontPath)
        -- On a Chinese client the game font keeps Chinese; Hangul gets 2002.
        env = buildUI("zhCN", "zhCN", nil, "koKR")
        widgets = env.ns.UI.Widgets
        font = env.CreateFrame("Frame"):CreateFontString()
        widgets.ChatFont(font, "升级循环")
        assert.are_not.equal("Fonts\\2002.TTF", font.fontPath)
        widgets.ChatFont(font, "레벨업")
        assert.equal("Fonts\\2002.TTF", font.fontPath)

        -- A Latin chat language under a Chinese UI drafts in Inter.
        env = buildUI("enUS", "zhCN", nil, "esES")
        widgets = env.ns.UI.Widgets
        font = env.CreateFrame("Frame"):CreateFontString()
        widgets.ChatFont(font, "")
        assert.equal("Interface\\AddOns\\WispAI\\Fonts\\Inter-Medium.ttf", font.fontPath)
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
            -- An empty edit box may receive the UI language's script.
            assert.is_false(widgets.InterSupports(""))
            local font = env.CreateFrame("Frame"):CreateFontString()
            widgets.ChatFont(font, env.ns.L["activity.thinking"])
            assert.equal(face, font.fontPath)
            font = env.CreateFrame("Frame"):CreateFontString()
            widgets.ChatFont(font, "")
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
        assert.is_false(env.ns.UI.Widgets.InterSupports(""))
        assert.is_false(env.ns.UI.Widgets.InterSupports("레벨업"))
    end)

    describe("with the UI in Chinese", function()
        local INTER = "Interface\\AddOns\\WispAI\\Fonts\\Inter-Medium.ttf"
        local INTER_STRONG = "Interface\\AddOns\\WispAI\\Fonts\\Inter-SemiBold.ttf"
        local ARKAI = "Fonts\\ARKai_T.ttf"
        -- Gives the stub the client's font objects, so Wisp's font roles exist.
        local function withFonts(env)
            env.CreateFont = function()
                return env.CreateFrame("Frame"):CreateFontString()
            end
            for _, name in ipairs({
                "GameFontNormalHuge",
                "GameFontNormalLarge",
                "GameFontHighlight",
                "GameFontHighlightSmall",
            }) do
                env[name] = env.CreateFont()
            end
        end

        for gameLocale, roleFace in pairs({ esES = ARKAI, zhCN = "Fonts\\FRIZQT__.TTF" }) do
            it(
                "keeps the script face for chrome and Inter for Latin text on " .. gameLocale,
                function()
                    local env = buildUI(gameLocale, "zhCN", withFonts)
                    local widgets = env.ns.UI.Widgets
                    local FONTS = widgets.FONTS
                    -- UI chrome is painted for Chinese: the script face on another
                    -- client, the client's own font on a Chinese one.
                    assert.equal(roleFace, FONTS.body.fontPath)
                    assert.equal(roleFace, FONTS.strong.fontPath)

                    -- User and game text in Latin keeps Inter, accents included.
                    local host = env.CreateFrame("Frame")
                    for text, role in pairs({
                        ["Rotación para subir de nivel"] = "strong",
                        ["¿Mejorar equipo en la subasta?"] = "body",
                        ["Mago 21 · Los Baldíos"] = "small",
                    }) do
                        local font = host:CreateFontString()
                        widgets.SetContentText(font, text, FONTS[role])
                        assert.equal(text, font:GetText())
                        assert.equal(role == "strong" and INTER_STRONG or INTER, font.fontPath)
                    end
                    assert.is_true(widgets.InterSupports("Rotación para subir de nivel"))
                    local chat = host:CreateFontString()
                    widgets.ChatFont(chat, "¿Mejorar equipo en la subasta?")
                    assert.equal(INTER, chat.fontPath)

                    -- Chinese text, from the UI or the player, keeps the role's face.
                    local chinese = host:CreateFontString()
                    widgets.SetContentText(chinese, env.ns.L["sidebar.newChat"], FONTS.body)
                    assert.equal(FONTS.body, chinese.font)
                    assert.are_not.equal(INTER, chinese.fontPath)
                    assert.is_false(widgets.InterSupports("升级循环"))

                    -- A recycled string switches faces both ways, although an
                    -- explicit face outlives SetFontObject.
                    local reused = host:CreateFontString()
                    widgets.SetContentText(reused, "Rotación para subir de nivel", FONTS.body)
                    assert.equal(INTER, reused.fontPath)
                    widgets.SetContentText(reused, "升级循环", FONTS.body)
                    assert.equal(roleFace, reused.fontPath)
                    assert.equal(FONTS.body.fontSize, reused.fontSize)
                    widgets.SetContentText(reused, "¿Mejorar equipo en la subasta?", FONTS.body)
                    assert.equal(INTER, reused.fontPath)

                    local row = host:CreateFontString()
                    widgets.ChatFont(row, "¿Mejorar equipo en la subasta?")
                    assert.equal(INTER, row.fontPath)
                    widgets.ChatFont(row, "升级循环")
                    assert.equal(roleFace, row.fontPath)
                    widgets.ChatFont(row, "Rotación para subir de nivel")
                    assert.equal(INTER, row.fontPath)
                end
            )
        end

        it("draws Korean chat text in the Korean face", function()
            local env = buildUI("enUS", "zhCN", withFonts, "koKR")
            local widgets = env.ns.UI.Widgets
            local FONTS = widgets.FONTS
            local host = env.CreateFrame("Frame")
            local korean = host:CreateFontString()
            widgets.SetContentText(korean, env.ns.ChatL["suggestion.whatCanYouDo"], FONTS.button)
            assert.equal("Fonts\\2002.TTF", korean.fontPath)
            -- Chinese UI text keeps the role's Chinese face.
            widgets.SetContentText(korean, env.ns.L["sidebar.newChat"], FONTS.button)
            assert.equal(ARKAI, korean.fontPath)
        end)

        it("shows Latin chat titles and the character line in Inter", function()
            local env = buildUI("esES", "zhCN", function(env)
                withFonts(env)
                env.UnitName = function()
                    return "Gandalfín"
                end
                env.UnitClass = function()
                    return "Mago"
                end
                env.UnitLevel = function()
                    return 21
                end
            end)
            local ns = env.ns
            ns.chats[1] = { id = "c1", title = "Rotación para subir de nivel", messages = {} }
            ns.chats[2] = { id = "c2", title = "升级循环", messages = {} }
            ns.UI.Sidebar.Refresh()
            local titles = {}
            for _, w in ipairs(env.UI_TEST.widgets) do
                if w.kind == "FontString" and w.text ~= "" then
                    titles[w.text] = w
                end
            end
            local latin = assert(titles["Rotación para subir de nivel"])
            assert.equal(INTER, latin.fontPath)
            local chinese = assert(titles["升级循环"])
            assert.are_not.equal(INTER, chinese.fontPath)
            assert.equal(INTER_STRONG, assert(titles["Gandalfín"]).fontPath)
            assert.equal(INTER, assert(titles["Mago 21"]).fontPath)
        end)
    end)

    it("keeps Inter for quoted tool labels and other general punctuation", function()
        local widgets = buildUI("enUS", "enUS").ns.UI.Widgets
        assert.is_true(widgets.InterSupports("Searching the web for “mount guide…”"))
        assert.is_true(widgets.InterSupports("Mage 20 · Elwynn Forest – it’s here"))
        assert.is_false(widgets.InterSupports("Searching for “炉石”"))
        assert.is_false(widgets.InterSupports("Arrow → right"))
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
