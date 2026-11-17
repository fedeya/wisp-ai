local _, ns = ...

-- Each file in Locales/ adds one table of UI strings keyed by identifier
-- ("sidebar.newChat"). enUS has every key; the others may leave keys out.
ns.Locales = ns.Locales or {}

--- Locales a player can pick in Settings, in menu order; "auto" follows the game.
ns.LOCALE_CHOICES = { "auto", "enUS", "esES", "esMX" }

--- The locale the UI shows: the Settings choice, or the game's language when
--- that is "auto" or has no table. Returns "enUS" when neither has one.
function ns.ActiveLocale()
    local chosen = ns.db and ns.db.language
    if chosen and chosen ~= "auto" and ns.Locales[chosen] then
        return chosen
    end
    local game = GetLocale and GetLocale()
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
