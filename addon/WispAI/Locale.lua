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

--- `ns.L[key]` is the active locale's text for a UI string, then English, then
--- the key itself so a missing string is easy to spot. Only UI chrome goes
--- through it; model output, user text and game names do not. Lookups are live,
--- so code that runs before saved variables load must store keys, not text.
ns.L = setmetatable({}, {
    __index = function(_, key)
        local active = ns.Locales[ns.ActiveLocale()]
        local english = ns.Locales.enUS
        return active and active[key] or english and english[key] or key
    end,
})

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
