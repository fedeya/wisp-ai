local _, ns = ...
local L = ns.L
local COLORS = ns.UI.Widgets.COLORS
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local MUTED = ns.UI.Widgets.MUTED
local memoryPanel, memoryContent, memoryStatus
local memoryRows = {}
function ns.UI.Memory.Refresh()
    if not memoryPanel then
        return
    end
    local memory = ns.memory or { status = "loading" }
    setText(
        memoryStatus,
        memory.status == "loading" and L["memory.loading"]
            or (
                memory.error
                or (#(memory.entries or {}) == 0 and L["memory.empty"] or L["memory.subtitle"])
            )
    )
    local y = 0
    for index, entry in ipairs(memory.entries or {}) do
        local row = memoryRows[index]
        if not row then
            row = CreateFrame("Frame", nil, memoryContent, "BackdropTemplate")
            box(row, COLORS.raised, COLORS.line)
            memoryRows[index] = row
            row.scope = label(row, "", COLORS.muted, ns.UI.Widgets.FONTS.caption)
            row.scope:SetPoint("TOPLEFT", 12, -10)
            row.text = label(row, "")
            row.text:SetWordWrap(true)
            row.text:SetPoint("TOPLEFT", 12, -26)
            row.edit = button(row, L["common.edit"], 45, function()
                StaticPopup_Show("WISPAI_EDIT_MEMORY", nil, nil, row.entry)
            end, "ghost")
            row.edit:SetPoint("TOPRIGHT", -62, -6)
            row.remove = button(row, L["memory.forget"], 54, function()
                ns.Chat.MemoryAction("remove", row.entry.slot, row.entry.key)
            end, "ghost")
            row.remove:SetPoint("TOPRIGHT", -6, -6)
        end
        row.entry = entry
        local width = math.max(220, memoryPanel:GetWidth() - 48)
        row:SetWidth(width)
        row.text:SetWidth(width - 24)
        ns.UI.Widgets.SetContentText(
            row.text,
            (entry.text:gsub("|", "||")),
            ns.UI.Widgets.FONTS.body
        )
        setText(
            row.scope,
            entry.slot == "preferences" and L["memory.player"] or L["memory.character"]
        )
        local height = row.text:GetStringHeight() + 38
        row:SetHeight(height)
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", 0, -y)
        row:Show()
        y = y + height + 12
    end
    for index = #(memory.entries or {}) + 1, #memoryRows do
        memoryRows[index]:Hide()
    end
    memoryContent:SetHeight(math.max(1, y))
end

function ns.UI.Memory.Build(settings)
    StaticPopupDialogs.WISPAI_EDIT_MEMORY = {
        text = L["memory.editTitle"],
        button1 = L["common.save"],
        button2 = L["common.cancel"],
        hasEditBox = true,
        maxLetters = 1000,
        OnShow = function(self, entry)
            local edit = self.GetEditBox and self:GetEditBox() or self.editBox
            edit:SetText(entry.text)
            edit:SetFocus()
        end,
        OnAccept = function(self, entry)
            local edit = self.GetEditBox and self:GetEditBox() or self.editBox
            ns.Chat.MemoryAction("save", entry.slot, entry.key, edit:GetText())
        end,
        timeout = 0,
        whileDead = true,
        hideOnEscape = true,
    }
    memoryPanel = CreateFrame("Frame", "WispAIMemoryPanel", settings, "BackdropTemplate")
    memoryPanel:SetAllPoints(settings)
    memoryPanel:SetFrameLevel(settings:GetFrameLevel() + 5)
    box(memoryPanel, COLORS.window, COLORS.window)
    memoryPanel:Hide()
    ns.UI.SettingsPanel.SubpageHeader(memoryPanel, L["memory.title"])
    local top = ns.UI.SettingsPanel.SUBPAGE_TOP
    memoryStatus = label(memoryPanel, "", MUTED)
    memoryStatus:SetPoint("TOPLEFT", 24, top)
    memoryStatus:SetPoint("RIGHT", -24, 0)
    memoryStatus:SetWordWrap(true)
    local memoryScroll
    memoryScroll, memoryContent = ns.UI.Widgets.ScrollArea(memoryPanel)
    memoryScroll:SetPoint("TOPLEFT", 24, top - 28)
    memoryScroll:SetPoint("BOTTOMRIGHT", -24, 16)
    memoryContent:SetSize(400, 1)
    memoryPanel:SetScript("OnSizeChanged", ns.UI.Memory.Refresh)
end
function ns.UI.Memory.IsShown()
    return memoryPanel ~= nil and memoryPanel:IsShown()
end
function ns.UI.Memory.Hide()
    if memoryPanel then
        memoryPanel:Hide()
    end
end
function ns.UI.Memory.Show()
    memoryPanel:Show()
    ns.Chat.MemoryAction("list")
end
