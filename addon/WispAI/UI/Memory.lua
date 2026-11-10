local _, ns = ...
local label, setText, box, button =
    ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.MUTED
local memoryPanel, memoryContent, memoryStatus
local memoryRows = {}
function ns.UI.Memory.Refresh()
    if not memoryPanel then
        return
    end
    local memory = ns.memory or { status = "loading" }
    setText(
        memoryStatus,
        memory.status == "loading" and "Loading memory..."
            or (
                memory.error
                or (
                    #(memory.entries or {}) == 0 and "No saved memories yet."
                    or "Preferences and this character's plans"
                )
            )
    )
    local y = 0
    for index, entry in ipairs(memory.entries or {}) do
        local row = memoryRows[index]
        if not row then
            row = CreateFrame("Frame", nil, memoryContent)
            memoryRows[index] = row
            row.text = label(row, "")
            row.text:SetFontObject(ChatFontNormal)
            row.text:SetWordWrap(true)
            row.text:SetPoint("TOPLEFT", 0, -2)
            row.scope = label(row, "", MUTED)
            row.scope:SetPoint("BOTTOMLEFT", 0, 3)
            row.edit = button(row, "Edit", 45, function()
                StaticPopup_Show("WISPAI_EDIT_MEMORY", nil, nil, row.entry)
            end)
            row.edit:SetPoint("BOTTOMRIGHT", -54, 0)
            row.remove = button(row, "Forget", 52, function()
                ns.Chat.MemoryAction("remove", row.entry.slot, row.entry.key)
            end)
            row.remove:SetPoint("BOTTOMRIGHT", 0, 0)
        end
        row.entry = entry
        local width = math.max(220, memoryPanel:GetWidth() - 65)
        row:SetWidth(width)
        row.text:SetWidth(width)
        setText(row.text, entry.text:gsub("|", "||"))
        setText(row.scope, entry.slot == "preferences" and "Player" or "Character")
        local height = math.max(40, row.text:GetStringHeight()) + 35
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
        text = "Edit saved memory",
        button1 = "Save",
        button2 = "Cancel",
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
    box(memoryPanel, { 0.10, 0.085, 0.065, 1 }, 12)
    memoryPanel:Hide()
    local memoryTitle = label(memoryPanel, "Memory", GOLD)
    memoryTitle:SetPoint("TOPLEFT", 20, -15)
    memoryStatus = label(memoryPanel, "", MUTED)
    memoryStatus:SetPoint("TOPLEFT", 20, -38)
    memoryStatus:SetPoint("RIGHT", -20, 0)
    memoryStatus:SetWordWrap(true)
    local memoryScroll = CreateFrame("ScrollFrame", nil, memoryPanel, "UIPanelScrollFrameTemplate")
    memoryScroll:SetPoint("TOPLEFT", 20, -75)
    memoryScroll:SetPoint("BOTTOMRIGHT", -35, 45)
    memoryContent = CreateFrame("Frame", nil, memoryScroll)
    memoryContent:SetSize(400, 1)
    memoryScroll:SetScrollChild(memoryContent)
    local memoryBack = button(memoryPanel, "Back", 90, function()
        memoryPanel:Hide()
    end)
    memoryBack:SetPoint("BOTTOMLEFT", 20, 12)
    memoryPanel:SetScript("OnSizeChanged", ns.UI.Memory.Refresh)
end
function ns.UI.Memory.Show()
    memoryPanel:Show()
    ns.Chat.MemoryAction("list")
end
