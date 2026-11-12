local _, ns = ...
local label, box, button = ns.UI.Widgets.Label, ns.UI.Widgets.Box, ns.UI.Widgets.Button
local GOLD, MUTED = ns.UI.Widgets.GOLD, ns.UI.Widgets.MUTED
local panel, content, status, nextButton, deleteButton, cancelButton, nameInput, scroll
local selected, transaction, expected, session
local rows, fields = {}, {}
local pools, used = {}, {}

local function widget(kind)
    pools[kind] = pools[kind] or {}
    used[kind] = (used[kind] or 0) + 1
    local pool, index = pools[kind], used[kind]
    if not pool[index] then
        if kind == "label" then
            pool[index] = label(content, "")
        elseif kind == "button" then
            pool[index] = button(content, "", 350, function() end)
        else
            pool[index] = CreateFrame(
                kind,
                nil,
                content,
                kind == "EditBox" and "InputBoxTemplate" or "UICheckButtonTemplate"
            )
        end
    end
    local result = pool[index]
    result:ClearAllPoints()
    result:Show()
    rows[#rows + 1] = result
    return result
end

local function active()
    local current = ns.Settings.PresetCharacter()
    assert(
        session == ns.session
            and expected
            and expected.name == current.name
            and expected.realm == current.realm,
        "Character/session changed; reopen presets"
    )
end
local function guarded(callback)
    return function()
        local ok, reason = pcall(function()
            active()
            callback()
        end)
        if not ok then
            transaction = nil
            nextButton:Hide()
            deleteButton:Hide()
            cancelButton:Hide()
            status:SetText(tostring(reason))
        end
    end
end
local function clear()
    for _, row in ipairs(rows) do
        row:Hide()
    end
    rows, fields, used = {}, {}, {}
    scroll:SetVerticalScroll(0)
    nameInput:Hide()
    nextButton:Hide()
    deleteButton:Hide()
    cancelButton:Hide()
end
local function text(value, y)
    local row = widget("label")
    row:SetText(value)
    row:SetPoint("TOPLEFT", 0, -y)
    row:SetWidth(360)
    row:SetWordWrap(true)
    return row
end
local function action(title, callback)
    nextButton:SetText(title)
    nextButton:SetScript("OnClick", guarded(callback))
    nextButton:Show()
end
local function mutate(undo)
    local capability = undo and "tool:undo_settings" or "tool:update_settings"
    local enabled = false
    for _, entry in ipairs(ns.capabilities or {}) do
        if entry.id == capability then
            enabled = entry.effective == true
        end
    end
    assert(
        ns.connected == true and enabled and not (ns.capabilityPending or {})[capability],
        "This tool is disabled, pending or unavailable in Settings"
    )
    local result = ns.Actions.PerformAction({
        kind = undo and "undo_settings" or "update_settings",
        args = undo and { transactionId = transaction.transactionId }
            or { operation = "apply", transactionId = transaction.transactionId },
        expectedCharacter = expected,
    })
    assert(
        result.status == "completed" and result.data and result.data.verified,
        result.error or "Verification failed"
    )
    status:SetText(
        undo and "Restored the values from just before Apply."
            or "Applied and verified. Undo is available while values stay unchanged."
    )
    nextButton:Hide()
    if not undo then
        action("Undo changes", function()
            mutate(true)
        end)
    end
end
local function review()
    transaction = ns.Settings.UpdateSettings({
        operation = "preview",
        presetId = selected.id,
        revision = selected.revision,
    })
    clear()
    text(selected.name .. " — fresh review", 0)
    for index, change in ipairs(transaction.changes) do
        text(
            change.id .. "\nAt review " .. change.before .. "  →  Desired " .. change.after,
            30 + (index - 1) * 48
        )
    end
    content:SetHeight(35 + #transaction.changes * 48)
    status:SetText("Fresh native values. Nothing applied. Review all changes before Apply.")
    action("Apply changes", function()
        mutate(false)
    end)
end
local list, selectPreset
local function confirmDelete()
    transaction = nil
    clear()
    text("Delete “" .. selected.name .. "”?", 0)
    text(
        "Removes this saved definition only.\nDoes not undo settings or erase transaction history.",
        40
    )
    content:SetHeight(110)
    status:SetText("Cancel keeps the definition. No game settings will be changed.")
    cancelButton:Show()
    cancelButton:SetScript(
        "OnClick",
        guarded(function()
            selectPreset(selected)
        end)
    )
    action("Delete definition", function()
        ns.Settings.DeletePreset(selected.id, selected.revision)
        list()
        status:SetText("Definition deleted. Game settings and transaction history unchanged.")
    end)
end
selectPreset = function(item)
    selected, transaction = item, nil
    clear()
    text(item.name .. " — saved desired values", 0)
    for index, entry in ipairs(item.entries) do
        text(entry.id .. " = " .. entry.value, 30 + (index - 1) * 28)
    end
    content:SetHeight(35 + #item.entries * 28)
    status:SetText("Saved definition only. Review reads current values; it does not apply.")
    action("Review changes", review)
    deleteButton:Show()
    deleteButton:SetScript("OnClick", guarded(confirmDelete))
end
list = function()
    selected, transaction = nil, nil
    clear()
    local items = ns.Settings.ListPresets()
    status:SetText("Choose a preset to review, or create one. No automatic switching.")
    if #items == 0 then
        text("No presets for this character yet.\nChoose New preset to select desired settings.", 0)
    end
    for index, item in ipairs(items) do
        local row = widget("button")
        row:SetText(item.name)
        row:SetScript(
            "OnClick",
            guarded(function()
                selectPreset(item)
            end)
        )
        row:SetPoint("TOPLEFT", 0, -(index - 1) * 32)
    end
    content:SetHeight(math.max(70, #items * 32))
end
local function edit()
    selected, transaction = nil, nil
    clear()
    nameInput:SetText("")
    nameInput:Show()
    text("Select CVars; enter desired numbers or true/false.", 0)
    local discovery = ns.Settings.ReadSettings({
        provider = "game",
        sections = { "options" },
        limit = 60,
    })
    local count = 0
    for _, option in ipairs(discovery.options) do
        if option.writable and ns.Shared.Numbers.IsFinite(tonumber(option.value)) then
            count = count + 1
            local check = widget("CheckButton")
            check:SetChecked(false)
            check:SetPoint("TOPLEFT", 0, -25 - (count - 1) * 52)
            local title = text(
                (option.label or option.id) .. "\nCurrent " .. option.value,
                25 + (count - 1) * 52
            )
            title:ClearAllPoints()
            title:SetPoint("TOPLEFT", 30, -25 - (count - 1) * 52)
            title:SetWidth(240)
            local input = widget("EditBox")
            input:SetText("")
            input:SetSize(70, 24)
            input:SetPoint("TOPLEFT", 280, -30 - (count - 1) * 52)
            input:SetAutoFocus(false)
            input:SetMaxLetters(32)
            fields[#fields + 1] = { id = option.id, check = check, input = input }
        end
    end
    content:SetHeight(30 + count * 52)
    status:SetText(
        discovery.nextOffset
                and "Select 1–12 from first 60 targets; not all game settings. Save makes no game writes."
            or "Name above; select 1–12 discovered CVars. Save stores desired values only."
    )
    action("Save definition", function()
        -- Only local form mistakes are retryable. The outer guard still fails
        -- closed on identity/session changes and fresh native Save validation.
        local name = nameInput:GetText()
        if #name < 1 or #name > 48 or not name:find("%S") or name:find("[%c|]") then
            status:SetText("Use a plain preset name (1–48 bytes), then retry Save.")
            return
        end
        local entries = {}
        for _, field in ipairs(fields) do
            if field.check:GetChecked() then
                local value = field.input:GetText()
                if value == "true" then
                    value = true
                elseif value == "false" then
                    value = false
                else
                    value = tonumber(value)
                end
                if type(value) ~= "boolean" and not ns.Shared.Numbers.IsFinite(value) then
                    status:SetText(
                        "Enter a finite number or true/false for each selected CVar, then retry Save."
                    )
                    return
                end
                entries[#entries + 1] = { id = field.id, value = value }
            end
        end
        if #entries < 1 or #entries > 12 then
            status:SetText("Select 1–12 CVars, then retry Save.")
            return
        end
        ns.Settings.SavePreset(name, entries)
        list()
        status:SetText("Definition saved. Select it to review fresh current values.")
    end)
end

function ns.UI.SettingsPresets.Show()
    if not panel then
        panel = CreateFrame("Frame", "WispAISettingsPresets", UIParent, "BackdropTemplate")
        panel:SetSize(430, 320)
        panel:SetPoint("CENTER")
        panel:SetFrameStrata("DIALOG")
        panel:SetFrameLevel(100)
        panel:EnableMouse(true)
        panel:SetClampedToScreen(true)
        box(panel, { 0.10, 0.085, 0.065, 1 }, 12)
        label(panel, "Desired settings presets", GOLD):SetPoint("TOPLEFT", 16, -14)
        local close = button(panel, "Close", 65, function()
            panel:Hide()
        end)
        close:SetPoint("TOPRIGHT", -14, -10)
        local caveat = label(
            panel,
            "Owned by this character. CVar scope unknown: changes may affect the account.",
            MUTED
        )
        caveat:SetPoint("TOPLEFT", 16, -43)
        caveat:SetWidth(395)
        caveat:SetWordWrap(true)
        button(panel, "Saved presets", 120, guarded(list)):SetPoint("TOPLEFT", 16, -78)
        button(panel, "New preset", 105, guarded(edit)):SetPoint("TOPLEFT", 143, -78)
        nameInput = CreateFrame("EditBox", nil, panel, "InputBoxTemplate")
        nameInput:SetPoint("TOPLEFT", 258, -78)
        nameInput:SetSize(150, 24)
        nameInput:SetAutoFocus(false)
        nameInput:SetMaxLetters(48)
        scroll = CreateFrame("ScrollFrame", nil, panel, "UIPanelScrollFrameTemplate")
        scroll:SetPoint("TOPLEFT", 16, -114)
        scroll:SetPoint("BOTTOMRIGHT", -35, 80)
        content = CreateFrame("Frame", nil, scroll)
        content:SetSize(365, 1)
        scroll:SetScrollChild(content)
        status = label(panel, "", MUTED)
        status:SetPoint("BOTTOMLEFT", 16, 42)
        status:SetWidth(395)
        status:SetWordWrap(true)
        nextButton = button(panel, "", 170, function() end)
        nextButton:SetPoint("BOTTOMRIGHT", -16, 12)
        deleteButton = button(panel, "Delete preset", 120, function() end)
        deleteButton:SetPoint("BOTTOMLEFT", 16, 12)
        cancelButton = button(panel, "Cancel", 90, function() end)
        cancelButton:SetPoint("BOTTOMLEFT", 16, 12)
    end
    panel:Show()
    clear()
    local ok, character = pcall(ns.Settings.PresetCharacter)
    if not ok then
        expected, session, selected, transaction = nil, nil, nil, nil
        status:SetText("Active character identity is unavailable. Reopen presets when readable.")
        return
    end
    expected = character
    session = ns.session
    guarded(list)()
end
