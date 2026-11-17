local helper = require("addon.tests.support")

local function buildUI(locale)
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    GetLocale = locale and function()
        return locale
    end or nil
    time = os.time
    ns = helper.namespace({
        db = { sidebar = true, drafts = {} },
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

it("shows the UI chrome in Spanish on an esES client", function()
    local env = buildUI("esES")
    local L = env.ns.L
    assert.equal("Nuevo chat", L["New chat"])
    assert.equal("¿A dónde vamos, %s?", L["Where to next, %s?"])
    assert.equal("Contexto ~24%", L["Context ~%.0f%%"]:format(24))
    assert.equal("Subida de nivel", env.ns.UI.Routines.EventLabel("level_up"))
    local starter = env.UI_TEST.frames.WispAIChatPlaceholder.starter
    assert.equal("¿Qué puedes hacer?", starter:GetText())
end)

it("falls back to English for unknown locales and untranslated strings", function()
    local env = buildUI("frFR")
    assert.equal("New chat", env.ns.L["New chat"])
    assert.equal("Level up", env.ns.UI.Routines.EventLabel("level_up"))
    env = buildUI("esMX")
    assert.equal("Rutinas", env.ns.L["Routines"])
    assert.equal("Not a UI string", env.ns.L["Not a UI string"])
end)
