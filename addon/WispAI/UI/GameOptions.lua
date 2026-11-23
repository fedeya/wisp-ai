local _, ns = ...
local L = ns.L
local ADDON_TITLE = "Wisp AI"

-- A page under the game's Options > AddOns that points players to Wisp's own
-- Settings, which live in the Wisp window rather than being duplicated here.
local page, description, open

local function closeGameOptions()
    if SettingsPanel and SettingsPanel.IsShown and SettingsPanel:IsShown() then
        HideUIPanel(SettingsPanel)
    elseif
        InterfaceOptionsFrame
        and InterfaceOptionsFrame.IsShown
        and InterfaceOptionsFrame:IsShown()
    then
        HideUIPanel(InterfaceOptionsFrame)
    end
    if GameMenuFrame and GameMenuFrame.IsShown and GameMenuFrame:IsShown() then
        HideUIPanel(GameMenuFrame)
    end
end

-- Puts the template's game face back, then swaps in a face for the UI
-- language's script when the game runs in another language (Korean on an
-- English client), as Wisp's own widgets do.
local function useLanguageFont(font, fontObject)
    if not font then
        return
    end
    local base = _G[fontObject]
    if base and base.GetFont then
        local path, size, flags = base:GetFont()
        if path then
            font:SetFont(path, size, flags or "")
        end
    end
    ns.UI.Widgets.UseLanguageFace(font, ns.ActiveLocale())
end

-- Texts are set on show so a language picked in Wisp applies without /reload.
local function localize()
    description:SetText(L["gameOptions.description"])
    useLanguageFont(description, "GameFontHighlight")
    open:SetText(L["gameOptions.open"])
    useLanguageFont(open:GetFontString(), "GameFontNormal")
end

--- Adds Wisp to the game's AddOns options, using the Settings API when the
--- client has it and the older Interface Options otherwise. Safe to call twice.
function ns.UI.GameOptions.Register()
    if page then
        return page
    end
    page = CreateFrame("Frame", "WispAIGameOptions")
    page.name = ADDON_TITLE

    local title = page:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
    title:SetPoint("TOPLEFT", 16, -16)
    title:SetText(ADDON_TITLE)
    description = page:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
    description:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
    description:SetPoint("RIGHT", -16, 0)
    description:SetJustifyH("LEFT")
    description:SetWordWrap(true)
    open = CreateFrame("Button", "WispAIGameOptionsOpen", page, "UIPanelButtonTemplate")
    open:SetSize(180, 24)
    open:SetPoint("TOPLEFT", description, "BOTTOMLEFT", 0, -12)
    open:SetScript("OnClick", function()
        closeGameOptions()
        ns.UI.ShowSettings("general")
    end)
    page:SetScript("OnShow", localize)
    localize()

    if Settings and Settings.RegisterCanvasLayoutCategory and Settings.RegisterAddOnCategory then
        local category = Settings.RegisterCanvasLayoutCategory(page, ADDON_TITLE)
        Settings.RegisterAddOnCategory(category)
        page.category = category
    elseif InterfaceOptions_AddCategory then
        InterfaceOptions_AddCategory(page)
    end
    return page
end
