local _, ns = ...
local COLORS = ns.UI.Widgets.COLORS
local label, setText, box = ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box
local MUTED = ns.UI.Widgets.MUTED
local capabilityPanel, capabilityContent, capabilityStatus, capabilityScroll
local capabilityRows, capabilityTabs = {}, {}
local capabilityGroup = "integrations"
function ns.UI.Capabilities.Refresh()
    if not capabilityPanel then
        return
    end
    local pending, values = ns.capabilityPending or {}, {}
    for _, entry in ipairs(ns.capabilities or {}) do
        local value = entry.enabled
        if pending[entry.id] then
            value = pending[entry.id].enabled
        end
        values[entry.id] = value
    end
    setText(
        capabilityStatus,
        ns.capabilityError
            or (
                not ns.capabilities and "Waiting for bridge..."
                or (
                    next(pending) and "Saving changes..."
                    or "New calls use these settings. Running calls may finish."
                )
            )
    )
    for group, tab in pairs(capabilityTabs) do
        ns.UI.Widgets.SetSelected(tab, group == capabilityGroup)
    end
    local y, used = 0, {}
    for _, entry in ipairs(ns.capabilities or {}) do
        if entry.group == capabilityGroup then
            local row = capabilityRows[entry.id]
            if not row then
                row = CreateFrame("Frame", nil, capabilityContent)
                capabilityRows[entry.id] = row
                row:SetHeight(32)
                row.check = ns.UI.Widgets.Toggle(row)
                row.check:SetPoint("RIGHT", -2, 0)
                row.text = label(row, "")
                row.text:SetPoint("LEFT", 0, 0)
                row.text:SetPoint("RIGHT", -110, 0)
                row.text:SetWordWrap(false)
                row.state = label(row, "", MUTED, ns.UI.Widgets.FONTS.small)
                row.state:SetPoint("RIGHT", row.check, "LEFT", -10, 0)
                local rule = row:CreateTexture(nil, "ARTWORK")
                rule:SetPoint("BOTTOMLEFT")
                rule:SetPoint("BOTTOMRIGHT")
                rule:SetHeight(ns.UI.Widgets.OnePixel(rule))
                ns.UI.Widgets.Tint(rule, COLORS.line)
                row.check:SetScript("OnClick", function(self)
                    ns.Chat.SetCapability(row.entry.id, self:GetChecked())
                end)
                row:EnableMouse(true)
                local function showHelp(self)
                    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
                    GameTooltip:SetText(row.entry.name)
                    GameTooltip:AddLine(row.entry.description, 0.85, 0.82, 0.75, true)
                    if row.entry.reason then
                        GameTooltip:AddLine(row.entry.reason, 0.7, 0.75, 0.65, true)
                    end
                    if row.entry.toolName then
                        GameTooltip:AddLine(row.entry.toolName, 0.6, 0.6, 0.6, true)
                    end
                    GameTooltip:Show()
                end
                row:SetScript("OnEnter", showHelp)
                row.check:SetScript("OnEnter", showHelp)
                row:SetScript("OnLeave", function()
                    GameTooltip:Hide()
                end)
                row.check:SetScript("OnLeave", function()
                    GameTooltip:Hide()
                end)
            end
            used[entry.id] = true
            row.entry = entry
            local blocked = entry.parent and values[entry.parent] == false
            local indent = entry.parent and 17 or 0
            row:SetWidth(math.max(210, capabilityPanel:GetWidth() - 48 - indent))
            row:ClearAllPoints()
            row:SetPoint("TOPLEFT", indent, -y)
            row.check:SetChecked(values[entry.id])
            row.check:SetEnabled(not blocked and not pending[entry.id])
            setText(row.text, entry.name)
            setText(
                row.state,
                pending[entry.id] and "Saving..."
                    or (
                        blocked and "Off"
                        or (
                            not entry.available and entry.status
                            or (values[entry.id] and "On" or "Off")
                        )
                    )
            )
            row:SetAlpha(blocked and 0.45 or 1)
            row:Show()
            y = y + 33
        end
    end
    for id, row in pairs(capabilityRows) do
        if not used[id] and row:IsShown() then
            row:Hide()
        end
    end
    capabilityContent:SetHeight(math.max(1, y))
end

function ns.UI.Capabilities.Build(settings)
    capabilityPanel = CreateFrame("Frame", "WispAICapabilitiesPanel", settings, "BackdropTemplate")
    capabilityPanel:SetAllPoints(settings)
    capabilityPanel:SetFrameLevel(settings:GetFrameLevel() + 5)
    box(capabilityPanel, COLORS.window, COLORS.window)
    capabilityPanel:Hide()
    ns.UI.SettingsPanel.SubpageHeader(capabilityPanel, "Integrations")
    local top = ns.UI.SettingsPanel.SUBPAGE_TOP
    for index, group in ipairs({ "integrations", "memory" }) do
        local tabGroup = group
        local text = group == "memory" and "Memory" or "Integrations"
        local tab = ns.UI.Widgets.NavItem(capabilityPanel, text, 26, function()
            capabilityGroup = tabGroup
            capabilityScroll:SetVerticalScroll(0)
            ns.UI.Capabilities.Refresh()
        end)
        tab:SetFontString(tab.label)
        tab.accentBar = true
        tab:SetText(text)
        tab:SetWidth(100)
        tab:SetPoint("TOPLEFT", 24 + (index - 1) * 104, top)
        capabilityTabs[group] = tab
    end
    capabilityStatus = label(capabilityPanel, "", MUTED, ns.UI.Widgets.FONTS.small)
    capabilityStatus:SetPoint("TOPLEFT", 24, top - 36)
    capabilityStatus:SetPoint("RIGHT", -24, 0)
    capabilityStatus:SetWordWrap(true)
    capabilityScroll, capabilityContent = ns.UI.Widgets.ScrollArea(capabilityPanel)
    capabilityScroll:SetPoint("TOPLEFT", 24, top - 58)
    capabilityScroll:SetPoint("BOTTOMRIGHT", -24, 16)
    capabilityContent:SetSize(400, 1)
    capabilityPanel:SetScript("OnSizeChanged", ns.UI.Capabilities.Refresh)
end
function ns.UI.Capabilities.IsShown()
    return capabilityPanel ~= nil and capabilityPanel:IsShown()
end
function ns.UI.Capabilities.Hide()
    if capabilityPanel then
        capabilityPanel:Hide()
    end
end
function ns.UI.Capabilities.Show()
    capabilityPanel:Show()
    ns.Transport.Send({ type = "capabilities_list" })
    ns.UI.Capabilities.Refresh()
end
