local helper = require("addon.tests.support")

local function load(language)
    local env = helper.env()
    env.ns = helper.namespace({ db = { language = language } })
    helper.addon("Chat/Snapshot.lua", env)
    return env.ns
end

describe("bridge notices", function()
    it("shows a known notice in the player's language and keeps everything else", function()
        local ns = load("esMX")
        local messages = {
            { role = "system", notice = "noProvider", text = "No AI is connected to Wisp yet." },
            { role = "system", text = "Model is no longer configured." },
            { role = "system", notice = "fromANewerBridge", text = "English fallback" },
            { role = "assistant", notice = "noProvider", text = "A reply" },
        }
        ns.Chat.LocalizeNotices(messages)
        assert.equal(ns.Locales.esMX["notice.noProvider"], messages[1].text)
        assert.equal("Model is no longer configured.", messages[2].text)
        assert.equal("English fallback", messages[3].text)
        assert.equal("A reply", messages[4].text)
    end)

    it("falls back to English when the locale has no translation", function()
        local ns = load("enUS")
        local messages = { { role = "system", notice = "noProvider", text = "bridge text" } }
        ns.Chat.LocalizeNotices(messages)
        assert.equal(ns.Locales.enUS["notice.noProvider"], messages[1].text)
        ns.Chat.LocalizeNotices(nil)
    end)
end)
