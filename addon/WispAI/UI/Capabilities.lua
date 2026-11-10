local _, ns = ...
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.MUTED
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
        tab:SetAlpha(group == capabilityGroup and 1 or 0.6)
    end
    local y, used = 0, {}
    for _, entry in ipairs(ns.capabilities or {}) do
        if entry.group == capabilityGroup then
            local row = capabilityRows[entry.id]
            if not row then
                row = CreateFrame("Frame", nil, capabilityContent)
                capabilityRows[entry.id] = row
                row:SetHeight(32)
                row.check = CreateFrame("CheckButton", nil, row, "UICheckButtonTemplate")
                row.check:SetSize(26, 26)
                row.check:SetPoint("LEFT", 0, 0)
                row.text = label(row, "")
                row.text:SetPoint("LEFT", row.check, "RIGHT", 3, 0)
                row.text:SetPoint("RIGHT", -70, 0)
                row.text:SetWordWrap(false)
                row.state = label(row, "", MUTED)
                row.state:SetPoint("RIGHT", -2, 0)
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
            row:SetWidth(math.max(210, capabilityPanel:GetWidth() - 65 - indent))
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
    box(capabilityPanel, { 0.10, 0.085, 0.065, 1 }, 12)
    capabilityPanel:Hide()
    local capabilityTitle = label(capabilityPanel, "Integrations", GOLD)
    capabilityTitle:SetPoint("TOPLEFT", 20, -15)
    for index, group in ipairs({ "integrations", "memory" }) do
        local tabGroup = group
        local tab = button(
            capabilityPanel,
            group == "memory" and "Memory" or "Integrations",
            85,
            function()
                capabilityGroup = tabGroup
                capabilityScroll:SetVerticalScroll(0)
                ns.UI.Capabilities.Refresh()
            end
        )
        tab:SetPoint("TOPLEFT", 20 + (index - 1) * 92, -40)
        capabilityTabs[group] = tab
    end
    capabilityStatus = label(capabilityPanel, "", MUTED)
    capabilityStatus:SetPoint("TOPLEFT", 20, -73)
    capabilityStatus:SetPoint("RIGHT", -20, 0)
    capabilityStatus:SetWordWrap(true)
    capabilityScroll =
        CreateFrame("ScrollFrame", nil, capabilityPanel, "UIPanelScrollFrameTemplate")
    capabilityScroll:SetPoint("TOPLEFT", 20, -105)
    capabilityScroll:SetPoint("BOTTOMRIGHT", -35, 45)
    capabilityContent = CreateFrame("Frame", nil, capabilityScroll)
    capabilityContent:SetSize(400, 1)
    capabilityScroll:SetScrollChild(capabilityContent)
    local capabilityBack = button(capabilityPanel, "Back", 90, function()
        capabilityPanel:Hide()
    end)
    capabilityBack:SetPoint("BOTTOMLEFT", 20, 12)
    capabilityPanel:SetScript("OnSizeChanged", ns.UI.Capabilities.Refresh)
end
function ns.UI.Capabilities.Show()
    capabilityPanel:Show()
    ns.Transport.Send({ type = "capabilities_list" })
    ns.UI.Capabilities.Refresh()
end
