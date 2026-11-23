-- Polestar readiness and read-only guide position adapter.
--
-- Polestar's documented API (Polestar.API.version 1) covers writing guides and
-- step messages, not reading them. The guide window's own readers on
-- Polestar.Engine (GetGuide, GetStepIndex, GetStepView, GetProgress) are used
-- here behind type checks and pcall, so a Polestar change degrades this read
-- instead of breaking Wisp.
local _, ns = ...
local numbers = ns.Shared.Numbers
local text = ns.Shared.Text

local API_VERSION = 1
local MAX_GOALS = 12
local MAX_UPCOMING_GOALS = 6
local TEXT_BYTES = 200
local NOTE_BYTES = 400

local function engine()
    local polestar = type(Polestar) == "table" and Polestar or nil
    local api = polestar and type(polestar.API) == "table" and polestar.API or nil
    local core = polestar and type(polestar.Engine) == "table" and polestar.Engine or nil
    return polestar, api, core
end

-- Strip WoW escape sequences (colors, textures, atlases, hyperlinks) and
-- bound the result; nil for anything that is not non-empty text.
local function plain(value, bytes)
    if type(value) ~= "string" then
        return nil
    end
    local clean = value
        :gsub("|c%x%x%x%x%x%x%x%x", "")
        :gsub("|r", "")
        :gsub("|T.-|t", "")
        :gsub("|A.-|a", "")
        :gsub("|H.-|h(.-)|h", "%1")
        :gsub("|n", " ")
        :gsub("%s+", " ")
        :match("^%s*(.-)%s*$")
    if clean == "" then
        return nil
    end
    return (text.TruncateUtf8Bytes(clean, bytes))
end

local function positive(value)
    return numbers.IsNonNegativeInteger(value) and value > 0 and value or nil
end

local function call(fn, ...)
    if type(fn) ~= "function" then
        return false
    end
    return pcall(fn, ...)
end

local function goalOf(view)
    local progress = type(view.progress) == "table" and view.progress or nil
    local cur = progress and numbers.IsNonNegativeInteger(progress.cur) and progress.cur or nil
    local max = progress and numbers.IsNonNegativeInteger(progress.max) and progress.max or nil
    return {
        text = plain(view.text, TEXT_BYTES),
        type = plain(view.t, 40),
        status = plain(view.status, 40),
        optional = view.optional == true or nil,
        progress = cur and max and { current = cur, required = max } or nil,
        questId = positive(view.quest),
        npcId = positive(view.npc),
        npcName = plain(view.npcName, TEXT_BYTES),
        itemId = positive(view.item),
        unavailable = plain(view.unavailableText, TEXT_BYTES),
    }
end

-- Goal views in order, skipping the ones Polestar folds into another row.
local function goalsOf(view, limit)
    local goals, total = {}, 0
    for _, goal in ipairs(type(view.goals) == "table" and view.goals or {}) do
        if type(goal) == "table" and not goal.folded and not goal.header then
            total = total + 1
            if #goals < limit then
                goals[#goals + 1] = goalOf(goal)
            end
        end
    end
    return goals, total > #goals
end

local function stepNumber(core, index)
    local ok, number, hidden = call(core.StepNumber, index)
    if ok and positive(number) and hidden ~= true then
        return number
    end
    return nil
end

local function stepOf(core, index, goalLimit)
    local ok, view = call(core.GetStepView, index)
    if not ok or type(view) ~= "table" then
        return { index = index, number = stepNumber(core, index) }
    end
    local goals, truncated = goalsOf(view, goalLimit)
    local section = type(view.section) == "table" and plain(view.section.title, TEXT_BYTES) or nil
    return {
        index = index,
        number = stepNumber(core, index),
        title = plain(view.title, TEXT_BYTES),
        note = plain(view.note, NOTE_BYTES),
        section = section,
        status = plain(view.status, 40),
        skipped = view.skipped == true or nil,
        why = plain(view.why, TEXT_BYTES),
        goals = goals,
        goalsTruncated = truncated or nil,
    }
end

function ns.Integrations._PolestarReport()
    local polestar, api, core = engine()
    local status = "missing"
    if polestar then
        status = "incompatible"
        if
            api
            and api.version == API_VERSION
            and core
            and type(core.GetGuide) == "function"
            and type(core.GetStepIndex) == "function"
        then
            status = type(core.GetStepView) == "function" and "ready" or "partial"
        end
    end
    return {
        status = status,
        version = polestar and ns.Integrations._AddonVersion("Polestar") or nil,
        guides = ns.Integrations._PolestarGuidesReady(),
    }
end

-- args.upcoming: how many steps after the shown one to include (0-5).
-- Returns the active tab's guide, the shown step with its goals and status,
-- the next steps, and overall progress; guide is nil when no guide is open.
function ns.Integrations.ReadPolestarGuide(args)
    local _, api, core = engine()
    assert(
        api and api.version == API_VERSION and core and type(core.GetGuide) == "function",
        "Polestar is not loaded or its version is not supported"
    )
    local result = {
        status = "available",
        source = "Polestar guide window",
        version = ns.Integrations._AddonVersion("Polestar"),
        note = "Read from Polestar's guide window; goal status is Polestar's own tracking. Use the live quest log to confirm quest state. Step numbers are the ones Polestar shows; index is its internal position.",
    }
    local guide = core.GetGuide()
    if type(guide) ~= "table" then
        result.note = "No Polestar guide is open in the active tab."
        return result
    end
    result.guide = {
        id = plain(guide.id, TEXT_BYTES),
        title = plain(guide.title, TEXT_BYTES),
        category = plain(guide.category, 80),
        pack = plain(guide.pack, 80),
    }
    local okTotal, total = call(core.StepTotal)
    local okCount, count = call(core.GetStepCount)
    result.stepCount = okTotal and positive(total) or okCount and positive(count) or nil
    local okProgress, done, of = call(core.GetProgress)
    if okProgress and numbers.IsNonNegativeInteger(done) and positive(of) then
        result.progress = { done = done, total = of }
    end
    local index = core.GetStepIndex()
    if not positive(index) then
        result.finished = true
        result.note = "The open Polestar guide has no current step; it is finished."
        return result
    end
    result.step = stepOf(core, index, MAX_GOALS)
    local okLive, live = call(core.GetLiveStep)
    if okLive and positive(live) and live ~= index then
        result.liveStepIndex = live
        result.liveStepNumber = stepNumber(core, live)
    end
    local upcoming = {}
    local last = positive(count) or index
    for next = index + 1, math.min(index + (args.upcoming or 2), last) do
        upcoming[#upcoming + 1] = stepOf(core, next, MAX_UPCOMING_GOALS)
    end
    result.upcoming = upcoming
    return result
end
