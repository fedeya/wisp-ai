local _, ns = ...
local writer = {}

local function showUnit(unit, visible)
    for _, region in ipairs(unit) do
        region:SetShown(visible)
    end
end

function writer.Finish(row)
    local writing = row.writing
    if not writing then
        return
    end
    for index = writing.snapshot.shown + 1, #writing.units do
        showUnit(writing.units[index], true)
    end
    writing.snapshot.shown = #writing.units
    row.writing = nil
    row:SetScript("OnUpdate", nil)
end

local function update(row, elapsed)
    local writing = row.writing
    writing.elapsed = writing.elapsed + elapsed
    while writing.elapsed >= writing.interval do
        writing.elapsed = writing.elapsed - writing.interval
        local snapshot = writing.snapshot
        snapshot.shown = snapshot.shown + 1
        showUnit(writing.units[snapshot.shown], true)
        if snapshot.shown == #writing.units then
            writer.Finish(row)
            break
        end
    end
end

-- Restore every region for layout, keeping the reveal position for this reply.
function writer.BeginLayout(row, sameReply, message, working, animateReply)
    local previous = sameReply and row.writingSnapshot
    local elapsed = sameReply and row.writing and row.writing.elapsed
    local shown = previous and previous.shown or 0
    writer.Finish(row)
    row.writingSnapshot = nil
    if
        message.role == "assistant"
        and (
            animateReply
            or elapsed
            or (previous and (previous.streaming or previous.pending))
            or (message.streaming and working)
        )
    then
        return {
            source = message.text or "",
            streaming = message.streaming,
            pending = message._markdownPending,
            previous = previous,
            shown = shown,
            elapsed = elapsed,
        }
    end
end

-- Each unit contains all visible regions in a formatted block. The renderer
-- has already reserved the final height for every unit.
function writer.Reveal(row, units, layout)
    local count = units and #units or 0
    local previous = layout.previous
    local preview = layout.pending and (not previous or previous.source == "" or previous.preview)
    local snapshot = {
        source = layout.source,
        shown = count,
        streaming = layout.streaming,
        pending = layout.pending,
        preview = preview,
    }
    row.writingSnapshot = snapshot
    if
        count == 0
        or not row:IsVisible()
        or preview
        or (previous and previous.preview)
        or (previous and layout.source:sub(1, #previous.source) ~= previous.source)
    then
        return
    end

    -- Start a batch immediately. If a batch is already running, retain its
    -- cursor and elapsed time when a stream update or resize redraws the row.
    local shown = math.min(count, layout.shown + (layout.elapsed and 0 or 1))
    snapshot.shown = shown
    if shown == count then
        return
    end
    for index = shown + 1, count do
        showUnit(units[index], false)
    end
    row.writing = {
        units = units,
        snapshot = snapshot,
        elapsed = layout.elapsed or 0,
        interval = math.min(0.075, 0.45 / (count - shown)),
    }
    row:SetScript("OnUpdate", update)
end

ns.UI.Writing = writer
