local _, C = ...
local M = {}
C.Markdown = M

local function literal(value)
    return C.Emoji.render((value:gsub("|", "||")))
end

local function validURL(url)
    return #url <= 2048 and url:match("^https?://[^/%?#]+") and not url:find('[%s%c|<>"\\]') and url
        or nil
end

local function urlLink(url)
    return "wispurl:"
        .. url:gsub(".", function(char)
            return string.format("%02x", string.byte(char))
        end)
end

function M.url(link)
    local hex = link:match("^wispurl:([%x]+)$")
    if not hex or #hex > 4096 or #hex % 2 ~= 0 then
        return nil
    end
    return validURL((hex:gsub("..", function(pair)
        return string.char(tonumber(pair, 16))
    end)))
end

local function closing(text, start, open, close)
    local depth, index = 1, start + 1
    while index <= #text do
        local char = text:sub(index, index)
        if char == "\\" then
            index = index + 1
        elseif char == open then
            depth = depth + 1
        elseif char == close then
            depth = depth - 1
            if depth == 0 then
                return index
            end
        end
        index = index + 1
    end
end

-- Keep native references and URLs atomic; delimiter parsing never touches their payloads.
function M.inline(value, inherited, depth)
    local output, text, index = {}, tostring(value or ""), 1
    inherited, depth = inherited or {}, depth or 0
    local function push(value, style)
        if value == "" then
            return
        end
        local span = { text = value }
        for key, setting in pairs(inherited) do
            span[key] = setting
        end
        for key, setting in pairs(style or {}) do
            span[key] = setting
        end
        local last = output[#output]
        if
            last
            and not span.reference
            and not last.reference
            and last.bold == span.bold
            and last.italic == span.italic
            and last.strike == span.strike
            and last.code == span.code
            and last.url == span.url
        then
            last.text = last.text .. value
        else
            output[#output + 1] = span
        end
    end
    local function nested(value, style)
        local combined = {}
        for key, setting in pairs(inherited) do
            combined[key] = setting
        end
        for key, setting in pairs(style) do
            combined[key] = setting
        end
        for _, span in ipairs(M.inline(value, combined, depth + 1)) do
            output[#output + 1] = span
        end
    end
    while index <= #text do
        local rest, handled = text:sub(index), false
        local char = rest:sub(1, 1)
        if char == "\\" and rest:sub(2, 2):match("%p") then
            push(rest:sub(2, 2))
            index, handled = index + 2, true
        elseif char == "`" then
            local marker = rest:match("^`+")
            local finish = text:find(marker, index + #marker, true)
            while
                finish
                and (
                    text:sub(finish - 1, finish - 1) == "`"
                    or text:sub(finish + #marker, finish + #marker) == "`"
                )
            do
                finish = text:find(marker, finish + #marker, true)
            end
            if finish then
                local code = text:sub(index + #marker, finish - 1):gsub("\n", " ")
                if code:match("^ .* $") and code:find("[^ ]") then
                    code = code:sub(2, -2)
                end
                push(code, { code = true })
                index, handled = finish + #marker, true
            else
                push(marker)
                index, handled = index + #marker, true
            end
        elseif rest:match("^%[%[ref:[%w_-]+%]%]") then
            local ref = rest:match("^%[%[ref:[%w_-]+%]%]")
            push(ref, { reference = true })
            index, handled = index + #ref, true
        elseif char == "[" or rest:sub(1, 2) == "![" then
            local start = index + (char == "!" and 1 or 0)
            local finish = closing(text, start, "[", "]")
            if finish and text:sub(finish + 1, finish + 1) == "(" then
                local ending = closing(text, finish + 1, "(", ")")
                local target = ending and text:sub(finish + 2, ending - 1)
                local url = target
                    and (
                        target:match("^%s*<([^>]+)>%s*$")
                        or target:match("^%s*(%S+)%s*$")
                        or target:match('^%s*(%S+)%s+"[^"]*"%s*$')
                    )
                if url and validURL(url) then
                    local label = text:sub(start + 1, finish - 1)
                    if depth < 12 then
                        nested(label ~= "" and label or url, { url = url })
                    else
                        push(label, { url = url })
                    end
                    index, handled = ending + 1, true
                elseif not ending then
                    push(rest)
                    index, handled = #text + 1, true
                end
            end
        elseif char == "<" then
            local url = rest:match("^<(https?://[^>]+)>")
            if url and validURL(url) then
                push(url, { url = url })
                index, handled = index + #url + 2, true
            end
        elseif rest:match("^https?://") then
            local url = rest:match("^https?://[^%s<>\"']+")
            url = url and url:gsub("[.,;:!?]+$", "")
            if url then
                local _, opens = url:gsub("%(", "")
                local _, closes = url:gsub("%)", "")
                while closes > opens and url:sub(-1) == ")" do
                    url, closes = url:sub(1, -2), closes - 1
                end
            end
            if url and validURL(url) then
                push(url, { url = url })
                index, handled = index + #url, true
            end
        end
        if not handled and depth < 12 and (char == "*" or char == "_" or char == "~") then
            local marker = rest:sub(1, 3)
            if marker ~= "***" and marker ~= "___" then
                marker = rest:sub(1, 2)
                if marker ~= "**" and marker ~= "__" and marker ~= "~~" then
                    marker = char ~= "~" and char or nil
                end
            end
            local previous = index > 1 and text:sub(index - 1, index - 1) or ""
            local nextChar = marker and text:sub(index + #marker, index + #marker) or ""
            local finish = marker
                and nextChar ~= ""
                and not nextChar:match("%s")
                and not (char == "_" and previous:match("[%w_]"))
                and text:find(marker, index + #marker, true)
            if finish and #marker == 2 and char ~= "~" then
                local run = text:sub(finish):match("^" .. (char == "*" and "%*+" or "_+"))
                if #run == 3 then
                    finish = finish + 1
                end
            elseif finish and #marker == 1 and text:sub(finish, finish + 1) == marker .. marker then
                local nestedEnd = text:find(marker .. marker, finish + 2, true)
                finish = nestedEnd and text:find(marker, nestedEnd + 2, true) or finish
            end
            while
                finish
                and (
                    text:sub(finish - 1, finish - 1):match("%s")
                    or text:sub(finish - 1, finish - 1) == "\\"
                    or (char == "_" and text:sub(finish + #marker, finish + #marker):match("[%w_]"))
                )
            do
                finish = text:find(marker, finish + #marker, true)
            end
            if finish then
                nested(text:sub(index + #marker, finish - 1), {
                    bold = #marker >= 2 and char ~= "~" or inherited.bold,
                    italic = (#marker == 1 or #marker == 3) and char ~= "~" or inherited.italic,
                    strike = char == "~" or inherited.strike,
                })
                index, handled = finish + #marker, true
            end
        end
        if not handled then
            -- Delimiters are ASCII: consume ordinary UTF-8 prose in one chunk.
            local nextSpecial = text:find("[\\`*_~%[!<h]", index + 1) or (#text + 1)
            push(text:sub(index, nextSpecial - 1))
            index = nextSpecial
        end
    end
    return output
end

local function spanText(span, references)
    local value = span.reference and C.MessageFormat.reference(span.text, references)
        or (span.code and span.text:gsub("|", "||") or literal(span.text))
    if span.url then
        return "|cff80c8ef|H" .. urlLink(span.url) .. "|h" .. value .. "|h|r"
    end
    return value
end

function M.format(value, references)
    local output = {}
    for _, span in ipairs(M.inline(value)) do
        local text = spanText(span, references)
        if span.code then
            text = "|cffb4d9ce" .. text .. "|r"
        elseif span.bold then
            text = "|cffe3c77e" .. text .. "|r"
        elseif span.italic or span.strike then
            text = "|cffaaa393" .. text .. "|r"
        end
        output[#output + 1] = text
    end
    return table.concat(output)
end

local function rule(line)
    if #line:match("^ *") > 3 then
        return false
    end
    local compact = line:gsub(" ", "")
    return #compact >= 3
        and (compact:match("^%-+$") or compact:match("^%*+$") or compact:match("^_+$"))
end

function M.blocks(value)
    local source = tostring(value or ""):gsub("\r\n", "\n")
    local result, paragraph, code, item = {}, {}, nil, nil
    local function flush()
        if #paragraph > 0 then
            result[#result + 1] = { kind = "paragraph", text = table.concat(paragraph, "\n") }
            paragraph = {}
        end
        item = nil
    end
    for line in (source .. "\n"):gmatch("(.-)\n") do
        local spaces, marker, tail = line:match("^( *)([`~]+)(.*)$")
        local fence = spaces
            and #spaces <= 3
            and #marker >= 3
            and (marker:match("^`+$") or marker:match("^~+$"))
        if code then
            if
                fence
                and marker:sub(1, 1) == code.fence
                and #marker >= code.length
                and tail:match("^%s*$")
            then
                code = nil
            else
                code.text = code.text .. (code.started and "\n" or "") .. line
                code.started = true
            end
        elseif fence and (marker:sub(1, 1) ~= "`" or not tail:find("`", 1, true)) then
            flush()
            code = {
                kind = "code",
                text = "",
                fence = marker:sub(1, 1),
                length = #marker,
                language = tail:match("^%s*([%w_+.-]+)"),
            }
            result[#result + 1] = code
        elseif line:match("^%s*$") then
            flush()
        else
            local indent, hashes, title = line:match("^( *)(#+)[ \t]+(.-)[ \t]*$")
            local setext = #paragraph > 0
                and (line:match("^ ? ? ?=+%s*$") or line:match("^ ? ? ?%-+%s*$"))
            local quote, quoted = line:match("^ ? ? ?(>+)[ \t]?(.*)$")
            if quote then
                while quoted:match("^>[ \t]?") do
                    quote, quoted = quote .. ">", quoted:gsub("^>[ \t]?", "", 1)
                end
            end
            local leading, bullet, body = line:match("^(%s*)([-+*])[ \t]+(.*)$")
            if not bullet then
                leading, bullet, body = line:match("^(%s*)(%d+[.)])[ \t]+(.*)$")
                if bullet and #bullet > 10 then
                    bullet = nil
                end
            end
            if indent and #indent <= 3 and #hashes <= 6 then
                flush()
                result[#result + 1] = {
                    kind = "heading",
                    level = #hashes,
                    text = title:gsub("[ \t]+#+$", ""),
                }
            elseif setext then
                result[#result + 1] = {
                    kind = "heading",
                    level = line:find("=", 1, true) and 1 or 2,
                    text = table.concat(paragraph, "\n"),
                }
                paragraph, item = {}, nil
            elseif rule(line) then
                flush()
                result[#result + 1] = { kind = "rule", text = "" }
            elseif quote then
                flush()
                local last = result[#result]
                if last and last.kind == "quote" and last.depth == #quote then
                    last.text = last.text .. "\n" .. quoted
                else
                    result[#result + 1] = { kind = "quote", text = quoted, depth = #quote }
                end
            elseif bullet then
                flush()
                local task, taskText = body:match("^%[([ xX])%][ \t]+(.*)$")
                item = {
                    kind = "list",
                    text = task and taskText or body,
                    indent = #(leading:gsub("\t", "    ")),
                    marker = bullet,
                    checked = task and task:lower() == "x",
                    task = task ~= nil,
                }
                result[#result + 1] = item
            elseif item and #line:match("^%s*") > item.indent then
                item.text = item.text .. "\n" .. line:gsub("^%s+", "")
            elseif line:match("^    ") or line:match("^\t") then
                flush()
                local last = result[#result]
                local content = line:gsub("^    ", "", 1):gsub("^\t", "", 1)
                if last and last.kind == "code" and not last.fence then
                    last.text = last.text .. "\n" .. content
                else
                    result[#result + 1] = { kind = "code", text = content }
                end
            else
                paragraph[#paragraph + 1] = line
            end
        end
    end
    flush()
    local numbers = {}
    for _, block in ipairs(result) do
        if block.kind == "list" then
            for indent in pairs(numbers) do
                if indent > block.indent then
                    numbers[indent] = nil
                end
            end
            local number, suffix = block.marker:match("^(%d+)([.)])$")
            if number then
                number = numbers[block.indent] and numbers[block.indent] + 1 or tonumber(number)
                numbers[block.indent] = number
                block.marker = number .. suffix
            else
                numbers[block.indent] = nil
            end
        else
            numbers = {}
        end
    end
    local changed = #result > 1
    for _, block in ipairs(result) do
        changed = changed or block.kind ~= "paragraph"
        if not changed then
            for _, span in ipairs(M.inline(block.text)) do
                changed = changed
                    or span.bold
                    or span.italic
                    or span.code
                    or span.strike
                    or span.url
            end
        end
    end
    return result, not not changed
end

local codeFont = "Interface\\AddOns\\WispAI\\Fonts\\JetBrainsMono-Regular.ttf"
local emphasisColor = { 227 / 255, 199 / 255, 126 / 255 }
local headingSizes = { 7, 5, 3, 2, 1, 0 }
local function styleFont(font, span, level)
    font:SetFontObject(ChatFontNormal)
    local path, size, flags = ChatFontNormal:GetFont()
    local height = size + (level and headingSizes[level] or 0)
    -- Emphasis and headings keep the localized game face. Conservatively restrict
    -- code to Latin/Greek/Cyrillic; unsupported scripts keep the game font too.
    if span.code and not span.text:find("[\212-\255]") then
        if font:SetFont(codeFont, height, flags) then
            return
        end
    end
    font:SetFont(path, height, flags)
end

function M.hide(pool, start)
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

function M.render(host, pool, value, references, width, y, count)
    count = count or 0
    local previous
    host.markdownMeasure = host.markdownMeasure
        or host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
    local measure = host.markdownMeasure
    measure:SetWordWrap(false)
    measure:Hide()
    width = math.max(1, width)
    for _, block in ipairs(M.blocks(value)) do
        if block.text ~= "" or block.kind == "rule" or block.kind == "code" then
            if previous then
                y = y
                    + (
                        block.level and 12
                        or (previous == "list" and block.kind == "list" and 4 or 8)
                    )
            end
            previous = block.kind
            count = count + 1
            local f = pool[count]
            if not f then
                f = host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
                pool[count] = f
            end
            -- Every pooled element may change its block type on the next stream update.
            M.hide({ f })
            f.runs = f.runs or {}
            f.block = block
            local top, x, used, decoration = y, 0, 0, 0
            local inset = block.kind == "code" and 10
                or (block.kind == "quote" and math.min(block.depth, 5) * 14 or 0)
            if block.kind == "list" then
                inset = math.min(block.indent, 24) * 7 + 26
            end
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
                local rendered = spanText(
                    { text = raw, reference = span.reference, url = span.url, code = span.code },
                    references
                )
                styleFont(measure, span, block.level)
                measure:SetText(rendered)
                local length = stringWidth(measure)
                if x > 0 and x + length > available then
                    newLine()
                end
                used = used + 1
                local run = used == 1 and f or f.runs[used - 1]
                if not run then
                    run = host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
                    f.runs[used - 1] = run
                end
                styleFont(run, span, block.level)
                run:SetJustifyH("LEFT")
                run:SetWordWrap(true)
                run:SetNonSpaceWrap(true)
                run:SetSpacing(3)
                local color = block.level and C.Widgets.GOLD
                    or (span.bold and emphasisColor)
                    or (
                        (block.kind == "quote" or span.strike or span.italic)
                            and C.Widgets.MUTED
                        or C.Widgets.TEXT
                    )
                run:SetTextColor(unpack(color))
                run:ClearAllPoints()
                run:SetPoint("TOPLEFT", inset + x, -y)
                run:SetWidth(math.max(1, math.min(length + 1, available - x)))
                C.Widgets.setText(run, rendered)
                run:Show()
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
                        { 0.1, 0.16, 0.15, 0.9 }
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
                local spans = block.kind == "code" and { { text = block.text, code = true } }
                    or M.inline(block.text)
                for _, span in ipairs(spans) do
                    if span.reference or span.url then
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
                                styleFont(measure, span, block.level)
                                measure:SetText(
                                    spanText(
                                        { text = chunk .. token, code = span.code },
                                        references
                                    )
                                )
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
                        { 0.055, 0.07, 0.075, 0.96 }
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
                    local marker = block.task
                            and (block.checked and "|TInterface\\Buttons\\UI-CheckBox-Check:18:18|t" or "|TInterface\\Buttons\\UI-CheckBox-Up:18:18|t")
                        or (block.marker:match("^%d") and block.marker or "-")
                    f.marker = f.marker or host:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
                    f.marker:SetFontObject(ChatFontNormal)
                    f.marker:SetText(marker)
                    f.marker:SetTextColor(
                        unpack(block.checked and { 0.5, 0.78, 0.55 } or C.Widgets.GOLD)
                    )
                    f.marker:SetJustifyH("RIGHT")
                    f.marker:SetWidth(math.min(20, math.max(1, inset - 3)))
                    f.marker:ClearAllPoints()
                    f.marker:SetPoint("TOPRIGHT", host, "TOPLEFT", inset - 6, -top)
                    f.marker:Show()
                end
            end
        end
    end
    return y, count
end
