local _, ns = ...
local GOLD, TEXT, MUTED = { 0.84, 0.72, 0.43 }, { 0.89, 0.85, 0.75 }, { 0.64, 0.60, 0.51 }
local function label(parent, text, tint)
    local font = parent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    font:SetText(text)
    font:SetTextColor(unpack(tint or TEXT))
    font:SetJustifyH("LEFT")
    return font
end
local function setText(font, value)
    if font._wispText ~= value then
        font._wispText = value
        font:SetText(value)
    end
end
local function box(frame, bg, edge)
    frame:SetBackdrop({
        bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        tile = true,
        tileSize = 16,
        edgeSize = edge or 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    frame:SetBackdropColor(unpack(bg))
    frame:SetBackdropBorderColor(0.43, 0.38, 0.28, 1)
end
local function button(parent, text, width, click)
    local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
    b:SetSize(width, 24)
    b:SetText(text)
    b:SetScript("OnClick", click)
    return b
end

local function showCopyUrl(url)
    StaticPopupDialogs.WISPAI_COPY_URL = StaticPopupDialogs.WISPAI_COPY_URL
        or {
            text = "Copy web address (Ctrl+C)",
            button2 = "Close",
            hasEditBox = true,
            maxLetters = 2048,
            OnShow = function(popup, value)
                local edit = popup.GetEditBox and popup:GetEditBox() or popup.editBox
                edit:SetText(value)
                edit:SetFocus()
                edit:HighlightText()
            end,
            timeout = 0,
            whileDead = true,
            hideOnEscape = true,
        }
    StaticPopup_Show("WISPAI_COPY_URL", nil, nil, url)
end

ns.UI.Widgets = {
    Label = label,
    SetText = setText,
    Box = box,
    Button = button,
    ShowCopyUrl = showCopyUrl,
    GOLD = GOLD,
    TEXT = TEXT,
    MUTED = MUTED,
}
