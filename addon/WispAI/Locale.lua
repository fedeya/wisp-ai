local _, ns = ...

-- Each file in Locales/ adds one table of UI strings keyed by identifier
-- ("sidebar.newChat"). enUS has every key; the others may leave keys out.
ns.Locales = ns.Locales or {}

--- Locales a player can pick in Settings, in menu order; "auto" follows the game.
ns.LOCALE_CHOICES = {
    "auto",
    "enUS",
    "deDE",
    "esES",
    "esMX",
    "frFR",
    "itIT",
    "ptBR",
    "ruRU",
    "koKR",
    "zhCN",
    "zhTW",
}
-- Game locales that share another locale's table.
local ALIASES = { enGB = "enUS", ptPT = "ptBR" }

--- The locale the UI shows: the Settings choice, or the game's language when
--- that is "auto" or has no table. Returns "enUS" when neither has one.
function ns.ActiveLocale()
    local chosen = ns.db and ns.db.language
    if chosen and chosen ~= "auto" and ns.Locales[chosen] then
        return chosen
    end
    local game = GetLocale and GetLocale()
    game = ALIASES[game] or game
    return game and ns.Locales[game] and game or "enUS"
end

--- Chat languages a player can pick in Settings, in menu order; "interface"
--- follows the UI language.
ns.CHAT_LOCALE_CHOICES = { "interface" }
for index = 2, #ns.LOCALE_CHOICES do
    ns.CHAT_LOCALE_CHOICES[index] = ns.LOCALE_CHOICES[index]
end

--- The locale of what Wisp writes for the player to send (suggestion chips,
--- routine requests) and of its greeting: the Settings choice, or the UI's.
--- Wisp answers in the language of each message, so this sets its replies too.
function ns.ChatLocale()
    local chosen = ns.db and ns.db.chatLanguage
    if chosen and chosen ~= "interface" and ns.Locales[chosen] then
        return chosen
    end
    return ns.ActiveLocale()
end

-- A table whose `[key]` is `locale()`'s text, then English, then the key.
local function lookup(locale)
    return setmetatable({}, {
        __index = function(_, key)
            local active = ns.Locales[locale()]
            local english = ns.Locales.enUS
            return active and active[key] or english and english[key] or key
        end,
    })
end

--- `ns.L[key]` is the active locale's text for a UI string, then English, then
--- the key itself so a missing string is easy to spot. Only UI chrome goes
--- through it; model output, user text and game names do not. Lookups are live,
--- so code that runs before saved variables load must store keys, not text.
ns.L = lookup(function()
    return ns.ActiveLocale()
end)

--- `ns.ChatL[key]` is like `ns.L[key]` in the chat language, for text Wisp
--- sends or offers to send on the player's behalf.
ns.ChatL = lookup(function()
    return ns.ChatLocale()
end)

--- `ns.LocaleText(key, values)` fills `{name}` placeholders in a UI string from
--- `values`, so a translation can put them in any order (string.format's `%s`
--- are positional). Unknown names stay as written.
function ns.LocaleText(key, values)
    return (
        ns.L[key]:gsub("{(%w+)}", function(name)
            local value = values[name]
            return value ~= nil and tostring(value) or nil
        end)
    )
end
