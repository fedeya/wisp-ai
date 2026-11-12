local _, ns = ...
local setText = ns.UI.Widgets.SetText
local truncateUtf8 = ns.Shared.Text.TruncateUtf8Bytes
local writingText, writingPrefix =
    ns.Markdown.InlineRenderer.WritingText, ns.Markdown.InlineRenderer.WritingPrefix
local writer = {}

local function drawWriting(entry, bytes)
    local prefix, shown = writingPrefix(entry.text, entry.visible, entry.ranges, bytes)
    entry.shown = shown
    setText(entry.font, prefix)
    local started = entry.startsAt and shown >= entry.startsAt
    if entry.setStarted and entry.started ~= started then
        entry.started = started
        entry.setStarted(started)
    end
end

function writer.Finish(row)
    local writing = row.writing
    if writing then
        for _, entry in ipairs(writing.entries) do
            setText(entry.font, entry.text)
            if entry.setStarted and not entry.started then
                entry.setStarted(true)
            end
        end
        row.writing = nil
        row:SetScript("OnUpdate", nil)
    end
end

local function updateWriting(row, elapsed)
    local writing = row.writing
    writing.elapsed = writing.elapsed + elapsed
    if writing.elapsed >= writing.duration then
        writer.Finish(row)
    elseif writing.elapsed - writing.updated >= 0.02 then
        writing.updated = writing.elapsed
        local position = writing.bytes * writing.elapsed / writing.duration
        while writing.index <= #writing.entries do
            local entry = writing.entries[writing.index]
            local progress = math.max(0, math.min(1, (position - entry.offset) / entry.bytes))
            drawWriting(entry, entry.start + math.floor(entry.bytes * progress))
            if progress < 1 then
                break
            end
            writing.index = writing.index + 1
        end
    end
end

local function matchWritingLayout(views, previous, interrupted)
    if not previous then
        return
    end
    local changed = #views ~= #previous.order
    if not changed then
        for index, view in ipairs(views) do
            if view.font ~= previous.order[index] then
                changed = true
                break
            end
        end
    end
    if not changed then
        return
    end
    local prefix = {}
    for _, font in ipairs(previous.order) do
        local visible = previous.fonts[font]
        local active = interrupted and interrupted.byFont[font]
        prefix[#prefix + 1] = active and visible:sub(1, active.shown) or visible
        if active and active.shown < #visible then
            break
        end
    end
    local shown = table.concat(prefix):gsub("%s+", "")
    local starts, position = {}, 1
    for _, view in ipairs(views) do
        local start = 0
        for index = 1, #view.visible do
            if position > #shown then
                break
            end
            local byte = view.visible:byte(index)
            if byte == 32 or (byte >= 9 and byte <= 13) then
                start = index
            elseif byte == shown:byte(position) then
                start, position = index, position + 1
            else
                return
            end
        end
        starts[view.font] = start
    end
    if position > #shown then
        return starts
    end
end

-- Restore full text for measurement while retaining the current reveal cursor.
function writer.BeginLayout(row, sameReply, message, working, animateReply)
    local previous = sameReply and row.writingSnapshot
    local interrupted = sameReply and row.writing
    writer.Finish(row)
    row.writingSnapshot = nil
    local animate = animateReply
        or interrupted
        or (previous and (previous.streaming or previous.pending))
        or (message.streaming and working)
    if message.role == "assistant" and animate then
        return {
            source = message.text or "",
            streaming = message.streaming,
            pending = message._markdownPending,
            previous = previous,
            interrupted = interrupted,
        }
    end
end

-- Renderers provide ordered units of text spans and an optional setStarted
-- callback for the visuals that appear with a unit's first visible character.
function writer.Reveal(row, units, layout)
    local source, previous, interrupted = layout.source, layout.previous, layout.interrupted
    local snapshot = {
        source = source,
        fonts = {},
        order = {},
        streaming = layout.streaming,
        pending = layout.pending,
    }
    row.writingSnapshot = snapshot
    if not units or not row:IsVisible() then
        return
    end
    local previousSource = previous and previous.source or ""
    local appended = source:sub(1, #previousSource) == previousSource
    -- Match existing fonts first. If Markdown changed the layout, fall back
    -- to the amount of new source measured from the end of the reply.
    local remaining = appended and #source:sub(#previousSource + 1):gsub("^%s+", "") or 0
    if previousSource == "" then
        remaining = math.huge
    end
    if
        previous
        and previousSource ~= ""
        and previous.pending
        and not layout.pending
        and appended
    then
        remaining = #source
    end
    if interrupted then
        for _, entry in ipairs(interrupted.entries) do
            remaining = remaining + #entry.visible - entry.shown
        end
    end
    local views = {}
    for _, unit in ipairs(units) do
        local setStarted = unit.setStarted
        for _, font in ipairs(unit.fonts) do
            local text = font:GetText() or ""
            local visible, ranges = writingText(text)
            snapshot.fonts[font] = visible
            snapshot.order[#snapshot.order + 1] = font
            local view = { font = font, text = text, visible = visible, ranges = ranges }
            local startsAt = setStarted and visible:find("%S")
            if startsAt then
                view.startsAt = startsAt
                view.setStarted = setStarted
                setStarted = nil
            end
            views[#views + 1] = view
        end
    end
    local layoutStarts = appended and matchWritingLayout(views, previous, interrupted)
    local entries, bytes = {}, 0
    for index = #views, 1, -1 do
        local view = views[index]
        local font, visible = view.font, view.visible
        local before = previous and previous.fonts[font]
        local active = interrupted and interrupted.byFont[font]
        local start = #visible - math.min(#visible, remaining)
        remaining = math.max(0, remaining - #visible)
        if layoutStarts then
            start = layoutStarts[font]
        elseif before then
            local shown = active and active.shown or #before
            if visible:sub(1, shown) == before:sub(1, shown) then
                start = shown
            end
        end
        if appended and start < #visible then
            start = #truncateUtf8(visible, start)
            view.start = start
            view.bytes = #visible - start
            entries[#entries + 1] = view
            bytes = bytes + view.bytes
        end
    end
    if #entries == 0 then
        return
    end
    local writing = {
        entries = {},
        byFont = {},
        index = 1,
        bytes = bytes,
        elapsed = 0,
        updated = 0,
        duration = math.min(0.9, math.max(0.14, bytes * 0.012)),
    }
    local offset = 0
    for index = #entries, 1, -1 do
        local entry = entries[index]
        entry.offset = offset
        offset = offset + entry.bytes
        writing.entries[#writing.entries + 1] = entry
        writing.byFont[entry.font] = entry
        drawWriting(entry, entry.start)
    end
    row.writing = writing
    local first = writing.entries[1]
    if first.start == 0 then
        local leading = first.visible:find("%S") or 1
        local firstBytes = (first.visible:find("[^\128-\191]", leading + 1) or #first.visible + 1)
            - 1
        writing.elapsed = writing.duration * firstBytes / writing.bytes
        drawWriting(first, firstBytes)
    end
    -- Keep the first glyph visible while syntax is pending. Starting the
    -- reveal on the raw preview would replay the same text after formatting.
    if layout.pending and previousSource == "" then
        snapshot.source = ""
        return
    end
    row:SetScript("OnUpdate", updateWriting)
end

ns.UI.Writing = writer
