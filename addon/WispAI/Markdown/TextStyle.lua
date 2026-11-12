local _, ns = ...
local layout = {}
local MAX_EXTRA_FONTS = 256
local codeFont = "Interface\\AddOns\\WispAI\\Fonts\\JetBrainsMono-Regular.ttf"
local headingSizes = { 7, 5, 3, 2, 1, 0 }
local HEADING = { 0.94, 0.92, 0.86 }
local CODE = { 0.82, 0.81, 0.77 }
local function styleFont(font, span, level)
    font:SetFontObject(ChatFontNormal)
    local path, size, flags = ChatFontNormal:GetFont()
    local height = size + (level and headingSizes[level] or 0)
    if span.code then
        height = math.max(10, math.floor(height * 0.86 + 0.5))
    end
    -- Emphasis and headings keep the localized game face. Conservatively restrict
    -- code to Latin/Greek/Cyrillic; unsupported scripts keep the game font too.
    if span.code and not span.text:find("[\212-\255]") then
        if font:SetFont(codeFont, height, flags) then
            return
        end
    end
    font:SetFont(path, height, flags)
end

function layout.Hide(pool, start)
    for index = start or 1, #pool do
        local f = pool[index]
        f:Hide()
        for _, run in ipairs(f.runs or {}) do
            run:Hide()
        end
        for _, decoration in ipairs(f.decorations or {}) do
            decoration:Hide()
        end
        if f.marker then
            f.marker:Hide()
        end
    end
end

local function texture(host, f, index, x, y, width, height, color, layer)
    f.decorations = f.decorations or {}
    local t = f.decorations[index] or host:CreateTexture(nil, layer or "BACKGROUND")
    f.decorations[index] = t
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", x, -y)
    t:SetSize(math.max(1, width), math.max(1, height))
    t:SetColorTexture(unpack(color))
    t:SetDrawLayer(layer or "BACKGROUND")
    t:Show()
end

local function stringWidth(font)
    return font.GetUnboundedStringWidth and font:GetUnboundedStringWidth() or font:GetStringWidth()
end

local function renderMarker(host, font, block, inset, top, unit)
    local text = block.task
            and (block.checked and "|TInterface\\Buttons\\UI-CheckBox-Check:18:18|t" or "|TInterface\\Buttons\\UI-CheckBox-Up:18:18|t")
        or (block.marker:match("^%d") and block.marker or "•")
    local marker = font.marker or host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
    font.marker = marker
    marker:SetFontObject(ChatFontNormal)
    marker:SetText(text)
    marker:SetTextColor(unpack(block.checked and { 0.5, 0.78, 0.55 } or ns.UI.Widgets.GOLD))
    marker:SetJustifyH("RIGHT")
    marker:SetWidth(math.min(20, math.max(1, inset - 3)))
    marker:ClearAllPoints()
    marker:SetPoint("TOPRIGHT", host, "TOPLEFT", inset - 6, -top)
    marker:Show()
    if unit then
        unit.setStarted = function(started)
            marker:SetShown(started)
        end
    end
end

-- A reveal unit owns every font span in this block and the visibility of its list marker.
function layout.Render(host, pool, part, width, y, count, collectWriting)
    count = count or 0
    local unit = collectWriting and { fonts = {} } or nil
    host.markdownMeasure = host.markdownMeasure
        or host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
    local measure = host.markdownMeasure
    measure:SetWordWrap(false)
    measure:Hide()
    width = math.max(1, width)
    local marker = part.marker and part.marker:gsub("%s+$", "")
    local blocks = {
        {
            text = part.text,
            kind = marker and "list" or part.style or "paragraph",
            level = part.level,
            indent = part.indent or 0,
            depth = 1,
            marker = marker,
            task = marker and marker:sub(1, 1) == "[",
            checked = marker == "[x]",
        },
    }
    for _, block in ipairs(blocks) do
        if block.text ~= "" or block.kind == "rule" or block.kind == "code" then
            count = count + 1
            local f = pool[count]
            if not f then
                f = host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
                pool[count] = f
            end
            -- Every pooled element may change its block type on the next stream update.
            layout.Hide({ f })
            f.runs = f.runs or {}
            f.block = block
            if block.kind == "heading" and y > 0 then
                y = y + 12
            end
            local top, x, used, decoration, simplified = y, 0, 0, 0, false
            local left = math.max(0, math.min(block.indent, math.max(0, width - 40)))
            local inset = left
                + (
                    block.kind == "code" and 10
                    or (block.kind == "quote" and math.min(block.depth, 5) * 14 or 0)
                )
            inset = math.min(inset, math.max(0, width - 24))
            local available = math.max(1, width - inset - (block.kind == "code" and 10 or 0))
            local lineHeight, lineUsed = 0, false
            local function newLine()
                y = y + math.max(16, lineHeight) + 3
                x, lineHeight, lineUsed = 0, 0, false
            end
            local function emit(raw, span)
                if raw == "" then
                    return
                end
                local rendered = raw
                styleFont(measure, span, block.level)
                measure:SetText(rendered)
                local length = stringWidth(measure)
                if x > 0 and x + length > available then
                    newLine()
                end
                used = used + 1
                local run = used == 1 and f or f.runs[used - 1]
                if not run then
                    if (host.styledExtras or 0) >= MAX_EXTRA_FONTS then
                        simplified = true
                        return
                    end
                    run = host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
                    f.runs[used - 1] = run
                    host.styledExtras = (host.styledExtras or 0) + 1
                end
                styleFont(run, span, block.level)
                run:SetJustifyH("LEFT")
                run:SetWordWrap(true)
                run:SetNonSpaceWrap(true)
                run:SetSpacing(3)
                local color = block.level and HEADING
                    or (
                        (block.kind == "quote" or span.strike) and ns.UI.Widgets.MUTED
                        or span.code and CODE
                        or ns.UI.Widgets.TEXT
                    )
                if span.color and not block.level then
                    local hex = span.color:match("^|c%x%x(%x%x%x%x%x%x)$")
                    if hex then
                        color = {
                            tonumber(hex:sub(1, 2), 16) / 255,
                            tonumber(hex:sub(3, 4), 16) / 255,
                            tonumber(hex:sub(5, 6), 16) / 255,
                        }
                    end
                end
                run:SetTextColor(unpack(color))
                run:ClearAllPoints()
                run:SetPoint("TOPLEFT", inset + x, -y)
                run:SetWidth(math.max(1, math.min(length + 1, available - x)))
                ns.UI.Widgets.SetText(run, rendered)
                run:Show()
                if unit then
                    unit.fonts[#unit.fonts + 1] = run
                end
                local h, w = run:GetStringHeight(), math.min(length, available - x)
                if span.code and block.kind ~= "code" then
                    decoration = decoration + 1
                    texture(
                        host,
                        f,
                        decoration,
                        inset + x - 1,
                        y,
                        w + 2,
                        h,
                        { 0.16, 0.15, 0.12, 0.45 }
                    )
                end
                if span.strike then
                    decoration = decoration + 1
                    texture(
                        host,
                        f,
                        decoration,
                        inset + x,
                        y + h / 2,
                        w,
                        1,
                        { 0.65, 0.61, 0.53, 1 },
                        "OVERLAY"
                    )
                end
                lineHeight, lineUsed = math.max(lineHeight, h), true
                x = x + w
                if length > available then
                    newLine()
                end
            end
            if block.kind == "rule" then
                texture(host, f, 1, 0, y + 5, width, 1, { 0.5, 0.43, 0.29, 0.6 })
                y = y + 12
            else
                if block.kind == "code" then
                    y = y + 8
                end
                local spans = part.runs or { { text = block.text, code = block.kind == "code" } }
                for _, span in ipairs(spans) do
                    if simplified then
                        break
                    end
                    if span.atomic then
                        emit(span.text, span)
                    else
                        -- Group words into line-sized chunks, rather than creating one widget per word.
                        local chunk = ""
                        local function flushChunk()
                            emit(chunk, span)
                            chunk = ""
                        end
                        local firstLine = true
                        for content in (span.text .. "\n"):gmatch("(.-)\n") do
                            if not firstLine then
                                newLine()
                            end
                            firstLine = false
                            if content:match("^%s+$") then
                                chunk = content
                            end
                            for token in content:gmatch("%s*%S+%s*") do
                                if simplified then
                                    break
                                end
                                styleFont(measure, span, block.level)
                                measure:SetText(chunk .. token)
                                if chunk ~= "" and x + stringWidth(measure) > available then
                                    flushChunk()
                                    if lineUsed then
                                        newLine()
                                    end
                                    if block.kind ~= "code" then
                                        token = token:gsub("^ +", "")
                                    end
                                end
                                chunk = chunk .. token
                            end
                            flushChunk()
                        end
                    end
                end
                if simplified then
                    -- Preserve the complete shared formatter output rather than
                    -- growing an unbounded set of inline widgets for dense prose.
                    layout.Hide({ f })
                    local text = block.kind == "list" and part.text:sub(#part.marker + 1)
                        or part.text
                    styleFont(f, { text = text, code = block.kind == "code" }, block.level)
                    f:ClearAllPoints()
                    f:SetPoint("TOPLEFT", left, -top)
                    f:SetWidth(math.max(1, width - left))
                    f:SetTextColor(unpack(block.level and HEADING or ns.UI.Widgets.TEXT))
                    ns.UI.Widgets.SetText(f, text)
                    f:Show()
                    if unit then
                        unit.fonts = { f }
                    end
                    if block.kind == "list" then
                        renderMarker(host, f, block, inset, top, unit)
                    end
                    return top + f:GetStringHeight() + (block.level and 6 or 0), count, unit
                end
                y = y + (lineUsed and math.max(16, lineHeight) or 0)
                if block.kind == "code" then
                    y = math.max(y + 8, top + 28)
                    decoration = decoration + 1
                    texture(
                        host,
                        f,
                        decoration,
                        0,
                        top,
                        width,
                        math.max(24, y - top),
                        { 0.035, 0.033, 0.028, 0.55 }
                    )
                elseif block.kind == "quote" then
                    decoration = decoration + 1
                    texture(
                        host,
                        f,
                        decoration,
                        inset - 9,
                        top,
                        2,
                        math.max(16, y - top),
                        { 0.65, 0.55, 0.34, 0.8 }
                    )
                elseif block.kind == "list" then
                    renderMarker(host, f, block, inset, top, unit)
                end
                if block.kind == "heading" then
                    y = y + 6
                end
            end
        end
    end
    return y, count, unit and #unit.fonts > 0 and unit or nil
end

ns.Markdown.TextStyle = layout
