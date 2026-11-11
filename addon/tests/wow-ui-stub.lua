-- Minimal stateful WoW widget API for renderer regression tests.
unpack = unpack or table.unpack
UI_TEST = { frames = {}, widgets = {}, textWrites = 0, hides = 0 }
function GetTime()
    return UI_TEST.now or 0
end
local methods = {}
local function widget(kind, name, parent)
    local w = setmetatable({
        kind = kind,
        name = name,
        parent = parent,
        shown = true,
        width = 400,
        height = 250,
        value = 0,
        scripts = {},
        text = "",
    }, {
        __index = function(_, key)
            if methods[key] then
                return methods[key]
            end
            if key:match("^%u") then
                return function() end
            end
        end,
    })
    if name then
        UI_TEST.frames[name] = w
    end
    UI_TEST.widgets[#UI_TEST.widgets + 1] = w
    return w
end
function methods:SetSize(w, h)
    self.width, self.height = w, h
end
function methods:SetWidth(w)
    self.width = w
end
function methods:SetHeight(h)
    self.height = h
end
function methods:GetWidth()
    return self.width
end
function methods:GetHeight()
    return self.height
end
function methods:SetText(t)
    self.text = t
    UI_TEST.textWrites = UI_TEST.textWrites + 1
end
function methods:GetText()
    return self.text
end
function methods:SetFontObject(font)
    if self.font == font then
        return
    end
    self.font = font
    self.fontPath, self.fontSize, self.fontFlags = "Fonts\\FRIZQT__.TTF", 14, ""
end
function methods:SetFont(path, size, flags)
    self.fontPath, self.fontSize, self.fontFlags = path, size, flags
    return true
end
function methods:SetTextColor(...)
    self.tint = { ... }
end
function methods:GetFont()
    return self.fontPath, self.fontSize, self.fontFlags
end
local function visible(text)
    return text:gsub("|T.-|t", "xx")
        :gsub("|c%x%x%x%x%x%x%x%x", "")
        :gsub("|H.-|h", "")
        :gsub("|h", "")
        :gsub("|r", "")
end
function methods:GetStringHeight()
    local size = self.fontSize or 14
    local lines = 0
    for line in (visible(self.text) .. "\n"):gmatch("(.-)\n") do
        lines = lines + math.max(1, math.ceil(#line * size / 2 / math.max(1, self.width)))
    end
    return lines * (size + 2)
end
function methods:GetUnboundedStringWidth()
    local plain = visible(self.text)
    local maximum = 0
    for line in (plain .. "\n"):gmatch("(.-)\n") do
        maximum = math.max(maximum, #line * (self.fontSize or 14) / 2)
    end
    return maximum
end
function methods:IsShown()
    return self.shown
end
methods.GetStringWidth = methods.GetUnboundedStringWidth
function methods:Show()
    self.shown = true
end
function methods:Hide()
    if self.shown then
        UI_TEST.hides = UI_TEST.hides + 1
    end
    self.shown = false
end
function methods:SetShown(v)
    if v then
        self:Show()
    else
        self:Hide()
    end
end
function methods:SetScript(name, fn)
    self.scripts[name] = fn
end
function methods:EnableMouse(enabled)
    self.mouseEnabled = enabled
end
function methods:SetHyperlinksEnabled(enabled)
    self.hyperlinksEnabled = enabled
end
function methods:SetChecked(value)
    self.checked = value
end
function methods:GetChecked()
    return self.checked
end
function methods:SetEnabled(value)
    self.enabled = value
end
function methods:SetHyperlink(link)
    UI_TEST.tooltipLink = link
end
function methods:CreateFontString()
    return widget("FontString", nil, self)
end
function methods:CreateTexture()
    return widget("Texture", nil, self)
end
function methods:SetThumbTexture()
    self.thumb = widget("Texture", nil, self)
end
function methods:GetThumbTexture()
    return self.thumb
end
function methods:SetValue(v)
    self.value = v
    if self.scripts.OnValueChanged then
        self.scripts.OnValueChanged(self, v)
    end
end
function methods:GetValue()
    return self.value
end
function methods:SetMinMaxValues(a, b)
    self.min, self.max = a, b
end
function methods:SetScrollChild(child)
    self.child = child
end
function methods:SetClipsChildren(enabled)
    self.clipsChildren = enabled
end
function methods:GetVerticalScrollRange()
    return math.max(0, (self.child and self.child.height or 0) - self.height)
end
function methods:SetVerticalScroll(v)
    self.scroll = v
end
function methods:GetVerticalScroll()
    return self.scroll or 0
end
function methods:GetFrameLevel()
    return 1
end
function methods:GetParent()
    return self.parent
end
function methods:SetParent(parent)
    self.parent = parent
end
function methods:SetPoint(point, relative, relativePoint, x, y)
    if type(relative) == "number" then
        x, y = relative, relativePoint
        relative, relativePoint = self.parent, point
    end
    self.point = { point, relative, relativePoint, x or 0, y or 0 }
end
function methods:GetPoint()
    return unpack(self.point or { "CENTER", UIParent, "CENTER", 0, 0 })
end
function CreateFrame(kind, name, parent)
    return widget(kind, name, parent)
end
UIParent = widget("Frame", "UIParent")
GameTooltip = widget("Frame", "GameTooltip")
GameFontNormal = {}
ChatFontNormal = {
    GetFont = function()
        return "Fonts\\FRIZQT__.TTF", 14, ""
    end,
}
C_Timer = { After = function() end }
StaticPopupDialogs = {}
function StaticPopup_Show(id, text, _, data)
    UI_TEST.popup = { id = id, text = text, data = data }
end
C_Item = {
    GetItemInfo = function()
        return nil
    end,
    RequestLoadItemDataByID = function() end,
}
C_Spell = {
    GetSpellLink = function()
        return nil
    end,
}
function SetItemRef(link)
    UI_TEST.clickedLink = link
end
function IsShiftKeyDown()
    return false
end
