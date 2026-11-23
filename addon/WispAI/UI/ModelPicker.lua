local _, ns = ...
local L = ns.L
local widgets = ns.UI.Widgets
local COLORS = widgets.COLORS

-- A searchable model list. Catalogs from aggregators run to hundreds of
-- models, more than a context menu can show, so the picker filters as the
-- player types and draws only the rows in view: a fixed set of row buttons is
-- repainted on scroll instead of one button per model.
local ROW_HEIGHT = 20
local VISIBLE_ROWS = 12
local MIN_WIDTH = 260
local SEARCH_HEIGHT = 24
local PADDING = 6

ns.UI.ModelPicker = {}

local picker
local state = { list = {}, offset = 0, active = nil }

--- Lowercased words of `query`, empty for a blank query.
local function words(query)
    local found = {}
    for word in tostring(query or ""):lower():gmatch("%S+") do
        found[#found + 1] = word
    end
    return found
end

local function matches(model, query)
    local text = (
        tostring(model.displayName or "")
        .. " "
        .. tostring(model.slug or "")
        .. " "
        .. tostring(model.group or "")
    ):lower()
    for _, word in ipairs(query) do
        if not text:find(word, 1, true) then
            return false
        end
    end
    return true
end

--- The rows for `models` filtered by `query`: `{ header = group }` before each
--- group's models when the catalog has more than one group, then
--- `{ model = model }` rows. Groups keep the order they first appear in.
--- @param models table[] catalog entries with slug, displayName and optional group
--- @param query string? words that must all appear in the name, slug or group
--- @return table[] rows
function ns.UI.ModelPicker._Rows(models, query)
    local wanted = words(query)
    local order, byGroup = {}, {}
    for _, model in ipairs(models or {}) do
        local group = model.group or ""
        if not byGroup[group] then
            byGroup[group] = {}
            order[#order + 1] = group
        end
        if matches(model, wanted) then
            table.insert(byGroup[group], model)
        end
    end
    local rows = {}
    for _, group in ipairs(order) do
        local members = byGroup[group]
        if #members > 0 then
            if #order > 1 and group ~= "" then
                rows[#rows + 1] = { header = group }
            end
            for _, model in ipairs(members) do
                rows[#rows + 1] = { model = model }
            end
        end
    end
    return rows
end

local function maxOffset()
    return math.max(0, #state.list - VISIBLE_ROWS)
end

local function paint()
    for index, row in ipairs(picker.rows) do
        local position = state.offset + index
        local entry = state.list[position]
        row.position = position
        row.entry = entry
        if not entry then
            row:Hide()
        else
            row:Show()
            local model = entry.model
            row:EnableMouse(model ~= nil)
            row.wash:SetShown(model ~= nil and position == state.active)
            row.mark:SetShown(model ~= nil and model.slug == state.selected)
            if model then
                row.text:SetFontObject(widgets.FONTS.small or "GameFontHighlightSmall")
                row.text:SetText(model.displayName or model.slug)
                local tint = model.slug == state.selected and widgets.ACCENT or widgets.TEXT
                row.text:SetTextColor(unpack(tint))
                row.text:SetPoint("LEFT", 22, 0)
            else
                row.text:SetFontObject(widgets.FONTS.caption or "GameFontNormalSmall")
                row.text:SetText(entry.header)
                row.text:SetTextColor(unpack(COLORS.muted))
                row.text:SetPoint("LEFT", 8, 0)
            end
        end
    end
    picker.empty:SetShown(#state.list == 0)
end

--- Moves the keyboard highlight to the next model row `step` rows away.
local function move(step)
    local position = state.active or 0
    repeat
        position = position + step
    until position < 1 or position > #state.list or state.list[position].model
    if position < 1 or position > #state.list then
        return
    end
    state.active = position
    if position <= state.offset then
        state.offset = position - 1
    elseif position > state.offset + VISIBLE_ROWS then
        state.offset = position - VISIBLE_ROWS
    end
    -- A group heading above the first match scrolls into view with it.
    if state.offset > 0 and position - state.offset == 1 and state.list[position - 1].header then
        state.offset = state.offset - 1
    end
    paint()
end

local function filter(query)
    state.list = ns.UI.ModelPicker._Rows(state.models, query)
    state.offset = 0
    state.active = nil
    move(1)
    paint()
end

local function choose(model)
    local pick = state.choose
    picker:Hide()
    if model and pick then
        pick(model.slug)
    end
end

local function build()
    local frame = CreateFrame("Frame", "WispAIModelPicker", UIParent, "BackdropTemplate")
    frame:SetFrameStrata("DIALOG")
    frame:SetToplevel(true)
    frame:SetClampedToScreen(true)
    frame:EnableMouse(true)
    frame:SetHeight(PADDING * 3 + SEARCH_HEIGHT + ROW_HEIGHT * VISIBLE_ROWS)
    widgets.Box(frame, COLORS.window, COLORS.lineStrong)
    if UISpecialFrames then
        table.insert(UISpecialFrames, "WispAIModelPicker")
    end

    local search = CreateFrame("EditBox", nil, frame, "BackdropTemplate")
    widgets.Box(search, COLORS.raised, COLORS.lineStrong)
    search:SetFontObject(widgets.FONTS.small or "GameFontHighlightSmall")
    search:SetTextColor(unpack(widgets.TEXT))
    search:SetTextInsets(8, 8, 0, 0)
    search:SetAutoFocus(false)
    search:SetMaxLetters(80)
    search:SetHeight(SEARCH_HEIGHT)
    search:SetPoint("TOPLEFT", PADDING, -PADDING)
    search:SetPoint("TOPRIGHT", -PADDING, -PADDING)
    local hint = widgets.Label(search, L["model.search"], COLORS.muted, widgets.FONTS.small)
    hint:SetPoint("LEFT", 8, 0)
    search:SetScript("OnTextChanged", function(self)
        local text = self:GetText() or ""
        hint:SetShown(text == "")
        filter(text)
    end)
    search:SetScript("OnEnterPressed", function()
        local entry = state.active and state.list[state.active]
        choose(entry and entry.model)
    end)
    search:SetScript("OnEscapePressed", function()
        frame:Hide()
    end)
    search:SetScript("OnArrowPressed", function(_, key)
        if key == "UP" then
            move(-1)
        elseif key == "DOWN" then
            move(1)
        end
    end)
    search:SetScript("OnTabPressed", function()
        move(IsShiftKeyDown() and -1 or 1)
    end)
    frame.search = search

    local list = CreateFrame("Frame", nil, frame)
    list:SetPoint("TOPLEFT", search, "BOTTOMLEFT", 0, -PADDING)
    list:SetPoint("TOPRIGHT", search, "BOTTOMRIGHT", 0, -PADDING)
    list:SetHeight(ROW_HEIGHT * VISIBLE_ROWS)
    list:EnableMouseWheel(true)
    list:SetScript("OnMouseWheel", function(_, delta)
        state.offset = math.max(0, math.min(maxOffset(), state.offset - delta * 3))
        paint()
    end)
    frame.rows = {}
    for index = 1, VISIBLE_ROWS do
        local row = CreateFrame("Button", nil, list)
        row:SetHeight(ROW_HEIGHT)
        row:SetPoint("TOPLEFT", 0, -(index - 1) * ROW_HEIGHT)
        row:SetPoint("TOPRIGHT", 0, -(index - 1) * ROW_HEIGHT)
        widgets.Hover(row, 0.04)
        row.wash = row:CreateTexture(nil, "BACKGROUND")
        row.wash:SetAllPoints()
        row.wash:SetColorTexture(unpack(COLORS.selected))
        row.mark = widgets.Dot(row, 6, widgets.ACCENT)
        row.mark:SetPoint("LEFT", 9, 0)
        row.text = widgets.Label(row, "", widgets.TEXT, widgets.FONTS.small)
        row.text:SetPoint("LEFT", 22, 0)
        row.text:SetPoint("RIGHT", -6, 0)
        row.text:SetJustifyH("LEFT")
        row.text:SetWordWrap(false)
        row:SetScript("OnClick", function(self)
            choose(self.entry and self.entry.model)
        end)
        frame.rows[index] = row
    end
    frame.empty = widgets.Label(list, L["model.noMatches"], COLORS.muted, widgets.FONTS.small)
    frame.empty:SetPoint("TOPLEFT", 8, -6)

    frame:SetScript("OnHide", function()
        search:ClearFocus()
        frame:UnregisterAllEvents()
        state.anchor, state.choose, state.models = nil, nil, nil
    end)
    -- A click anywhere else closes the picker, as it would a menu.
    frame:SetScript("OnEvent", function()
        local over = MouseIsOver
            and (MouseIsOver(frame) or (state.anchor and MouseIsOver(state.anchor)))
        if MouseIsOver and not over then
            frame:Hide()
        end
    end)
    frame:Hide()
    return frame
end

--- Opens the picker under `anchor`, or closes it when it is already open there.
--- `options.models` are catalog entries (slug, displayName, optional group),
--- `options.selected` the current slug, and `options.choose(slug)` runs after a
--- pick, with the picker already closed.
function ns.UI.ModelPicker.Toggle(anchor, options)
    picker = picker or build()
    if picker:IsShown() and state.anchor == anchor then
        picker:Hide()
        return
    end
    picker:Hide()
    state.anchor = anchor
    state.models = options.models or {}
    state.selected = options.selected
    state.choose = options.choose
    picker:ClearAllPoints()
    picker:SetPoint("BOTTOMLEFT", anchor, "TOPLEFT", 0, 4)
    picker:SetWidth(math.max(MIN_WIDTH, anchor:GetWidth() or 0))
    picker:Show()
    pcall(picker.RegisterEvent, picker, "GLOBAL_MOUSE_DOWN")
    picker.search:SetText("")
    filter("")
    -- Start on the current model, scrolled to the middle of the list.
    for position, entry in ipairs(state.list) do
        if entry.model and entry.model.slug == state.selected then
            state.active = position
            local middle = position - math.floor(VISIBLE_ROWS / 2)
            state.offset = math.max(0, math.min(maxOffset(), middle))
        end
    end
    paint()
    picker.search:SetFocus()
end

function ns.UI.ModelPicker.Close()
    if picker then
        picker:Hide()
    end
end
