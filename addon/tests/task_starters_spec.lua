local helper = require("addon.tests.support")

-- Opt-in geometry for this feature only: resolve production anchors and wrapped
-- font metrics, then deliver size callbacks as the client would after layout.
local function geometry(env)
    local function fraction(point, axis)
        if point:find(axis == 1 and "LEFT" or "BOTTOM") then
            return 0
        elseif point:find(axis == 1 and "RIGHT" or "TOP") then
            return 1
        end
        return 0.5
    end
    local resolve
    resolve = function(w, axis)
        if w == env.UIParent then
            return 0, axis == 1 and 1920 or 1080
        end
        local low, high, middle
        for _, p in pairs(w.anchors or {}) do
            local start, size = resolve(p[2], axis)
            local value = start + fraction(p[3], axis) * size + p[axis + 3]
            local f = fraction(p[1], axis)
            if f == 0 then
                low = value
            elseif f == 1 then
                high = value
            else
                middle = value
            end
        end
        if low and high then
            return low, high - low
        end
        local size = axis == 1 and w.width or w.height
        if w.kind == "FontString" then
            if axis == 1 and not w.explicitWidth then
                size = w:GetUnboundedStringWidth()
            elseif axis == 2 and not w.explicitHeight then
                size = w:GetStringHeight()
            end
        end
        return low or (high and high - size) or (middle and middle - size / 2) or 0, size
    end
    local function instrument(w)
        w.anchors = {}
        w.ClearAllPoints = function(self)
            self.anchors = {}
        end
        w.SetPoint = function(self, point, relative, relativePoint, x, y)
            if type(relative) == "number" then
                x, y, relative, relativePoint = relative, relativePoint, self.parent, point
            end
            self.anchors[point] = {
                point,
                relative or self.parent,
                relativePoint or point,
                x or 0,
                y or 0,
            }
        end
        w.SetAllPoints = function(self, relative)
            self:ClearAllPoints()
            self:SetPoint("TOPLEFT", relative or self.parent, "TOPLEFT")
            self:SetPoint("BOTTOMRIGHT", relative or self.parent, "BOTTOMRIGHT")
        end
        w.GetWidth = function(self)
            local _, size = resolve(self, 1)
            return size
        end
        w.GetHeight = function(self)
            local _, size = resolve(self, 2)
            return size
        end
        w.SetWidth = function(self, value)
            self.width, self.explicitWidth = value, true
        end
        w.SetHeight = function(self, value)
            self.height, self.explicitHeight = value, value > 0
        end
        w.SetSize = function(self, width, height)
            self:SetWidth(width)
            self:SetHeight(height)
        end
        w.SetWordWrap = function(self, value)
            self.wrap = value
        end
        w.GetUnconstrainedStringHeight = function(self)
            local size, lines = self.fontSize or 14, 0
            local width = self.wrap == false and math.huge or math.max(1, self:GetWidth())
            for line in (self.text .. "\n"):gmatch("(.-)\n") do
                -- Greedy word wrapping with bounded glyph widths, including long words.
                local used = 0
                lines = lines + 1
                for word in line:gmatch("%S+") do
                    local pixels = #word * size / 2
                    if used > 0 and used + size / 2 + pixels > width then
                        lines, used = lines + 1, 0
                    end
                    lines = lines + math.max(0, math.ceil(pixels / width) - 1)
                    used = (used > 0 and used + size / 2 or 0) + pixels
                end
            end
            return lines * (size + 2)
        end
        w.GetStringHeight = function(self)
            local height = self:GetUnconstrainedStringHeight()
            -- ClearAllPoints preserves an explicit height. A positive height can
            -- constrain displayed text; SetHeight(0) restores natural measurement.
            return self.explicitHeight and math.min(height, self.height) or height
        end
        for _, name in ipairs({ "CreateFontString", "CreateTexture" }) do
            local create = w[name]
            w[name] = function(self, ...)
                return instrument(create(self, ...))
            end
        end
        if w.kind == "Button" then
            local font = w:CreateFontString()
            font:SetPoint("CENTER", w, "CENTER")
            w.GetFontString = function()
                return font
            end
            local setText = w.SetText
            w.SetText = function(self, text)
                setText(self, text)
                font:SetText(text)
            end
        end
        w.SetFocus = function(self)
            self.focused = true
        end
        w.ClearFocus = function(self)
            self.focused = false
        end
        return w
    end
    local create = env.CreateFrame
    env.CreateFrame = function(...)
        return instrument(create(...))
    end
    env.UI_TEST.bounds = function(w)
        local x, width = resolve(w, 1)
        local y, height = resolve(w, 2)
        return { left = x, right = x + width, bottom = y, top = y + height }
    end
    env.UI_TEST.settle = function()
        for _ = 1, 12 do
            local changed = false
            for _, w in ipairs(env.UI_TEST.widgets) do
                if w.anchors then
                    local width, height = w:GetWidth(), w:GetHeight()
                    if width ~= w.lastWidth or height ~= w.lastHeight then
                        w.lastWidth, w.lastHeight = width, height
                        changed = true
                        if w.scripts.OnSizeChanged then
                            w.scripts.OnSizeChanged(w, width, height)
                        end
                    end
                end
            end
            if not changed then
                return
            end
        end
        error("geometry did not settle within 12 passes")
    end
end

local function setup(withGeometry)
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    if withGeometry then
        geometry(env)
    end
    env.time = function()
        return 100
    end
    env.UnitName = function()
        return "Fixture"
    end
    local createFrame = env.CreateFrame
    env.CreateFrame = function(...)
        local frame = createFrame(...)
        frame.events = {}
        frame.RegisterEvent = function(self, name)
            self.events[name] = true
        end
        return frame
    end
    env.ns = helper.namespace({
        db = { sidebar = true, showTools = true, drafts = {} },
        active = "chat",
        connected = true,
        session = "test",
        pendingMessages = {},
        pendingChats = {},
        workStarted = {},
        deletedChats = {},
        chats = { { id = "chat", title = "Draft", status = "idle", messages = {} } },
        capabilities = {
            { id = "core:wow", enabled = true, available = true },
            { id = "core:wisp", enabled = true, available = true },
            { id = "tool:inspect_trainer", parent = "core:wow", enabled = true, available = true },
            { id = "tool:query_character", parent = "core:wow", enabled = true, available = true },
            { id = "tool:manage_panel", parent = "core:wisp", enabled = true, available = true },
        },
    })
    env.GetNumTrainerServices = function()
        return 1
    end
    env.GetTrainerServiceInfo = function()
        return "Test service", "available"
    end
    helper.addon("Character/Inspect.lua", env)
    env.C_QuestLog = {
        GetNumQuestLogEntries = function()
            return 1
        end,
        GetInfo = function()
            return { questID = 1, isHeader = false, isHidden = false }
        end,
    }
    helper.addon("Character/TaskContext.lua", env)
    helper.addon("Chat/State.lua", env)
    local sent = {}
    env.ns.Transport.Send = function(packet)
        sent[#sent + 1] = packet
    end
    helper.addon("UI/Window.lua", env)
    env.ns.UI.BuildUI()
    return env, env.ns, sent
end

local function event(env, name)
    for _, frame in ipairs(env.UI_TEST.widgets) do
        if frame.events and frame.events[name] and frame.scripts.OnEvent then
            frame.scripts.OnEvent(frame, name)
        end
    end
end

local function assertFullCopyMeasurement(ui)
    local placeholder = ui.frames.WispAIChatPlaceholder
    local outer = ui.bounds(placeholder)
    for _, font in ipairs({ placeholder.title, placeholder.detail }) do
        local natural = font:GetUnconstrainedStringHeight()
        assert.equals(natural, font:GetHeight(), "stale height constraint: " .. font:GetText())
        assert.equals(natural, font:GetStringHeight(), "copy must not be clipped")
        if font:IsShown() then
            local bounds = ui.bounds(font)
            assert.is_true(bounds.top <= outer.top)
            assert.is_true(bounds.bottom >= outer.bottom)
        end
    end
end

it("remeasures full wrapped copy after a large-to-minimum resize", function()
    local env, ns, sent = setup(true)
    local ui = env.UI_TEST
    event(env, "TRAINER_SHOW")
    ui.settle()
    assertFullCopyMeasurement(ui)
    local before = ui.frames.WispAIChatPlaceholder.detail:GetHeight()
    local widgets = #ui.widgets
    ui.frames.WispAIWindow:SetSize(430, 320)
    ns.UI.Refresh()
    ui.settle()
    assertFullCopyMeasurement(ui)
    assert.is_true(ui.frames.WispAIChatPlaceholder.detail:GetHeight() > before)
    ui.frames.WispAIWindow:SetSize(610, 490)
    ui.settle()
    assertFullCopyMeasurement(ui)
    assert.equals(before, ui.frames.WispAIChatPlaceholder.detail:GetHeight())
    assert.equals(widgets, #ui.widgets)
    assert.equals(0, #sent)
end)

it("remeasures loading, disconnected and connected copy without retained clipping", function()
    local env, ns, sent = setup(true)
    local ui = env.UI_TEST
    ui.frames.WispAIWindow:SetSize(430, 320)
    ns.Chat.Current().messages = nil
    ns.UI.Refresh()
    ui.settle()
    assertFullCopyMeasurement(ui)
    local short = ui.frames.WispAIChatPlaceholder.detail:GetHeight()
    local widgets = #ui.widgets
    ns.connected = false
    ns.UI.Refresh()
    ui.settle()
    assertFullCopyMeasurement(ui)
    assert.is_true(ui.frames.WispAIChatPlaceholder.detail:GetHeight() > short)
    ns.connected = true
    ns.Chat.Current().messages = {}
    ns.UI.Refresh()
    ui.settle()
    assertFullCopyMeasurement(ui)
    ns.Chat.Current().messages = nil
    ns.UI.Refresh()
    ui.settle()
    assertFullCopyMeasurement(ui)
    assert.equals(short, ui.frames.WispAIChatPlaceholder.detail:GetHeight())
    assert.equals(widgets, #ui.widgets)
    assert.equals(0, #sent)
end)

it(
    "offers at most three local tasks and prepares only an editable draft until manual Send",
    function()
        local env, ns, sent = setup()
        event(env, "TRAINER_SHOW")
        ns.UI.Refresh()
        local card
        for _, widget in ipairs(env.UI_TEST.widgets) do
            if widget:GetText() == "Review trainer offers" then
                card = widget
            end
        end
        assert.is_not_nil(card, "empty chat needs a task starter")
        assert.equals("Review trainer offers", card:GetText())
        assert.is_true(card:IsShown())
        card.scripts.OnClick(card)
        assert.matches("trainer", ns.draft:GetText())
        assert.equals(ns.draft:GetText(), ns.db.drafts.chat)
        assert.equals(0, #sent)
        local prepared = ns.draft:GetText()
        ns.draft:SetText("")
        ns.draft.scripts.OnTextChanged(ns.draft)
        assert.equals("", ns.db.drafts.chat)
        assert.is_true(ns.UI.TaskStarters.Select("trainer", "chat"))
        assert.equals(prepared, ns.draft:GetText())
        ns.Chat.Submit()
        assert.equals(1, #sent)
        assert.equals("say", sent[1].type)
    end
)

it(
    "removes trainer invitations on close and rejects stale clicks without erasing a draft",
    function()
        local env, ns, sent = setup()
        event(env, "TRAINER_SHOW")
        assert.is_true(ns.UI.TaskStarters.Select("trainer", "chat"))
        local prepared = ns.draft:GetText()
        event(env, "TRAINER_CLOSED")
        assert.is_false(ns.Character.IsTrainerOpen())
        env.ClassTrainerFrame = {
            IsShown = function()
                return true
            end,
        }
        local observation = ns.Character.Inspect({ kind = "trainer" })
        assert.equals("unavailable", observation.status)
        assert.matches("keep the trainer window open", observation.error)
        assert.equals(prepared, ns.draft:GetText())
        assert.is_false(ns.UI.TaskStarters.Select("quests", "chat"))
        ns.draft:SetText("")
        ns.db.drafts.chat = ""
        assert.is_false(ns.UI.TaskStarters.Select("trainer", "chat"))
        for _, widget in ipairs(env.UI_TEST.widgets) do
            assert.is_false(widget:IsShown() and widget:GetText() == "Review trainer offers")
        end
        assert.equals(0, #sent)
    end
)

it("hides tasks for disconnected, loading, working and unavailable states", function()
    local _, ns = setup()
    local chat = ns.Chat.Current()
    ns.connected = false
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "chat"))
    ns.connected = true
    chat.messages = nil
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "chat"))
    chat.messages, chat.status = {}, "working"
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "chat"))
    chat.status = "idle"
    ns.capabilities[5].available = false
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "chat"))
    ns.capabilities[5].available = true
    ns.capabilities[2].enabled = false
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "chat"))
    ns.capabilities = nil
    assert.is_false(ns.UI.TaskStarters.Select("quests", "chat"))
end)

it(
    "contains the actual launcher at minimum size and restores cards without side effects",
    function()
        local env, ns, sent = setup(true)
        local ui = env.UI_TEST
        local window = ui.frames.WispAIWindow
        local placeholder = ui.frames.WispAIChatPlaceholder
        local transcript = placeholder.anchors.TOPLEFT[2]
        local reads = 0
        env.C_QuestLog.GetInfo = function()
            reads = reads + 1
            return { questID = 1, isHeader = false, isHidden = false }
        end
        event(env, "TRAINER_SHOW")
        event(env, "QUEST_LOG_UPDATE")
        ui.settle()
        local initialReads, widgets = reads, #ui.widgets
        local function inside(w, outer)
            local b = ui.bounds(w)
            assert.is_true(b.top <= outer.top + 0.01, "top overflow: " .. w:GetText())
            assert.is_true(b.bottom >= outer.bottom - 0.01, "bottom overflow: " .. w:GetText())
            assert.is_true(b.left >= outer.left - 0.01, "left overflow: " .. w:GetText())
            assert.is_true(b.right <= outer.right + 0.01, "right overflow: " .. w:GetText())
            return b
        end
        for _, size in ipairs({
            { 430, 320 },
            { 610, 490 },
            { 1000, 900 },
            { 430, 320 },
            { 610, 490 },
        }) do
            for _, sidebar in ipairs({ true, false }) do
                ns.db.sidebar = sidebar
                window:SetSize(unpack(size))
                ns.UI.Refresh()
                ui.settle()
                local outer = ui.bounds(placeholder)
                assert.equals(transcript:GetHeight(), placeholder:GetHeight())
                assert.is_true(outer.bottom >= ui.bounds(ns.draft:GetParent():GetParent()).top)
                assert.is_true(outer.top <= ui.bounds(placeholder:GetParent()).top)
                if size[1] == 430 and sidebar then
                    assert.equals(112, placeholder:GetHeight())
                    assert.is_true(placeholder.detail:GetStringHeight() > 16, "detail must wrap")
                end
                local previous = inside(placeholder.title, outer)
                if placeholder.detail:IsShown() then
                    local detail = inside(placeholder.detail, outer)
                    assert.is_true(detail.top <= previous.bottom)
                    previous = detail
                end
                local count, trainer = 0, false
                for _, w in ipairs(ui.widgets) do
                    if w.parent == placeholder and w.kind == "Button" and w:IsShown() then
                        local b = inside(w, outer)
                        inside(w:GetFontString(), b)
                        assert.is_true(b.top <= previous.bottom, "launcher elements overlap")
                        previous = b
                        count = count + 1
                        trainer = trainer or w.taskId == "trainer"
                    end
                end
                assert.is_true(trainer, "keep the contextual trainer card")
                assert.is_true(count <= 3)
                if size[2] >= 490 then
                    assert.equals(3, count)
                    assert.is_true(placeholder.detail:IsShown())
                end
            end
        end
        ns.draft:SetText("my draft")
        ns.draft:SetFocus()
        ns.draft.scripts.OnTextChanged(ns.draft)
        event(env, "TRAINER_CLOSED")
        window:SetSize(430, 320)
        ns.UI.Refresh()
        ui.settle()
        assert.equals("my draft", ns.draft:GetText())
        assert.equals("my draft", ns.db.drafts.chat)
        assert.is_true(ns.draft.focused)
        assert.equals(initialReads, reads)
        assert.equals(widgets, #ui.widgets)
        assert.equals(0, #sent)
        ns.draft:SetText("")
        ns.db.drafts.chat = ""
        event(env, "TRAINER_SHOW")
        assert.is_true(ns.UI.TaskStarters.Select("trainer", "chat"))
        local prepared = ns.draft:GetText()
        window:SetSize(610, 490)
        ui.settle()
        event(env, "TRAINER_CLOSED")
        assert.equals(prepared, ns.draft:GetText())
        assert.equals(prepared, ns.db.drafts.chat)
        assert.is_true(ns.draft.focused)
        assert.equals(initialReads, reads)
        assert.equals(widgets, #ui.widgets)
        assert.equals(0, #sent)
    end
)

it("preserves prepared and typed drafts when switching or creating conversations", function()
    local _, ns = setup()
    assert.is_true(ns.UI.TaskStarters.Select("tracker", "chat"))
    local prepared = ns.draft:GetText()
    ns.chats[1].title = "New conversation"
    ns.chats[2] = { id = "other", title = "Other", status = "idle", messages = {} }
    ns.Chat.Select("other")
    assert.equals(2, #ns.chats)
    ns.draft:SetText("my own question")
    ns.Chat.Select("chat")
    assert.equals(prepared, ns.draft:GetText())
    assert.is_false(ns.UI.TaskStarters.Select("tracker", "other"))
    ns.Chat.NewChat()
    assert.equals(prepared, ns.db.drafts.chat)
    assert.equals("", ns.draft:GetText())
    ns.Chat.Select("other")
    assert.equals("my own question", ns.draft:GetText())
end)

it("bounds quest eligibility and never treats missing or restricted readings as empty", function()
    local env, ns = setup()
    local reads = 0
    env.C_QuestLog.GetNumQuestLogEntries = function()
        return 1000
    end
    env.C_QuestLog.GetInfo = function()
        reads = reads + 1
        return { isHeader = true, isHidden = false }
    end
    assert.is_nil(ns.Character.HasActiveQuests())
    assert.equals(100, reads)
    env.C_QuestLog.GetNumQuestLogEntries = function()
        return 1
    end
    env.C_QuestLog.GetInfo = function()
        return {}
    end
    assert.is_nil(ns.Character.HasActiveQuests())
    env.C_QuestLog.GetNumQuestLogEntries = function()
        return 0
    end
    assert.is_false(ns.Character.HasActiveQuests())
    env.C_QuestLog.GetNumQuestLogEntries = function()
        error("restricted")
    end
    assert.is_nil(ns.Character.HasActiveQuests())
    event(env, "PLAYER_ENTERING_WORLD")
    assert.is_false(ns.UI.TaskStarters.Select("quests", "chat"))
    env.C_QuestLog = nil
    assert.is_nil(ns.Character.HasActiveQuests())
end)

it("refreshes quest cards on events without polling the quest APIs", function()
    local env, ns = setup()
    local reads = 0
    env.C_QuestLog.GetInfo = function()
        reads = reads + 1
        return { questID = 1, isHeader = false, isHidden = false }
    end
    event(env, "QUEST_LOG_UPDATE")
    local afterEvent = reads
    for _ = 1, 10 do
        ns.UI.Refresh()
    end
    assert.equals(afterEvent, reads)
    assert.is_true(ns.UI.TaskStarters.Select("quests", "chat"))
    ns.draft:SetText("")
    ns.db.drafts.chat = ""
    env.C_QuestLog.GetNumQuestLogEntries = function()
        return 0
    end
    event(env, "QUEST_LOG_UPDATE")
    assert.is_false(ns.UI.TaskStarters.Select("quests", "chat"))
end)
