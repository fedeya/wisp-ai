local _, ns = ...
local M = {}
ns.Markdown = M
local TICK = string.char(96)

-- Wisp's inline grammar emits semantic nodes, without native UI dependencies.
local function trim(value)
    return (value:gsub("^[ \t\r\n]+", ""):gsub("[ \t\r\n]+$", ""))
end

local function utf8(value)
    if value <= 0x7F then
        return string.char(value)
    elseif value <= 0x7FF then
        return string.char(0xC0 + math.floor(value / 64), 0x80 + value % 64)
    elseif value <= 0xFFFF then
        return string.char(
            0xE0 + math.floor(value / 4096),
            0x80 + math.floor(value / 64) % 64,
            0x80 + value % 64
        )
    end
    return string.char(
        0xF0 + math.floor(value / 262144),
        0x80 + math.floor(value / 4096) % 64,
        0x80 + math.floor(value / 64) % 64,
        0x80 + value % 64
    )
end

local function codepoint(source, offset)
    local a, b, c, d = source:byte(offset, offset + 3)
    if not a then
        return nil, offset
    end
    if a < 0x80 then
        return a, offset + 1
    end
    local count = a >= 0xC2 and a <= 0xDF and 2
        or a >= 0xE0 and a <= 0xEF and 3
        or a >= 0xF0 and a <= 0xF4 and 4
    if not count then
        return 0xFFFD, offset + 1
    end
    if not b or b < 0x80 or b > 0xBF then
        return 0xFFFD, offset + 1
    end
    if count >= 3 and (not c or c < 0x80 or c > 0xBF) then
        return 0xFFFD, offset + 1
    end
    if count == 4 and (not d or d < 0x80 or d > 0xBF) then
        return 0xFFFD, offset + 1
    end
    if
        a == 0xE0 and b < 0xA0
        or a == 0xED and b >= 0xA0
        or a == 0xF0 and b < 0x90
        or a == 0xF4 and b >= 0x90
    then
        return 0xFFFD, offset + 1
    end
    local value = count == 2 and (a - 0xC0) * 64 + b - 0x80
        or count == 3 and (a - 0xE0) * 4096 + (b - 0x80) * 64 + c - 0x80
        or (a - 0xF0) * 262144 + (b - 0x80) * 4096 + (c - 0x80) * 64 + d - 0x80
    return value, offset + count
end

local function previous(source, offset)
    if offset <= 1 then
        return nil
    end
    offset = offset - 1
    while offset > 1 do
        local byte = source:byte(offset)
        if byte < 0x80 or byte >= 0xC0 then
            break
        end
        offset = offset - 1
    end
    return codepoint(source, offset)
end

local function whitespace(value)
    return not value
        or value == 9
        or value == 10
        or value == 12
        or value == 13
        or value == 32
        or value == 0xA0
        or value == 0x1680
        or value >= 0x2000 and value <= 0x200A
        or value == 0x202F
        or value == 0x205F
        or value == 0x3000
end

local function punctuation(value)
    return value
        and (
            value >= 33 and value <= 47
            or value >= 58 and value <= 64
            or value >= 91 and value <= 96
            or value >= 123 and value <= 126
            or value >= 0x2000 and value <= 0x206F
            or value >= 0x2190 and value <= 0x2BFF
            or value >= 0x3000 and value <= 0x303F
            or value >= 0x1F000 and value <= 0x1FAFF
        )
end

local accents = {}
for _, pair in ipairs({
    { "Á", "á" },
    { "É", "é" },
    { "Í", "í" },
    { "Ó", "ó" },
    { "Ú", "ú" },
    { "Ü", "ü" },
    { "Ñ", "ñ" },
    { "À", "à" },
    { "È", "è" },
    { "Ì", "ì" },
    { "Ò", "ò" },
    { "Ù", "ù" },
    { "Â", "â" },
    { "Ê", "ê" },
    { "Î", "î" },
    { "Ô", "ô" },
    { "Û", "û" },
    { "Ä", "ä" },
    { "Ë", "ë" },
    { "Ï", "ï" },
    { "Ö", "ö" },
    { "Ç", "ç" },
}) do
    accents[pair[1]] = pair[2]
end

local entities = { amp = "&", lt = "<", gt = ">", quot = '"', apos = "'", nbsp = " " }
local function entityAt(source, offset)
    local name, after = source:match("^&([A-Za-z]+);()", offset)
    if name and entities[name] then
        return entities[name], after
    end
    local digits
    digits, after = source:match("^&#([0-9]+);()", offset)
    local base = 10
    if not digits then
        digits, after = source:match("^&#[xX]([0-9A-Fa-f]+);()", offset)
        base = 16
    end
    if digits and #digits <= 8 then
        local value = tonumber(digits, base)
        if value == 0 or value > 0x10FFFF or value >= 0xD800 and value <= 0xDFFF then
            value = 0xFFFD
        end
        return utf8(value), after
    end
end

local function escapable(char)
    local value = char:byte()
    return value and value < 128 and punctuation(value)
end

local function unescape(source, work)
    local chunks, start, offset = {}, 1, 1
    while offset <= #source do
        if work then
            work()
        end
        local char, replacement, after = source:sub(offset, offset)
        if char == "\\" and escapable(source:sub(offset + 1, offset + 1)) then
            replacement, after = source:sub(offset + 1, offset + 1), offset + 2
        elseif char == "&" then
            replacement, after = entityAt(source, offset)
        end
        if replacement then
            chunks[#chunks + 1], chunks[#chunks + 2] = source:sub(start, offset - 1), replacement
            offset, start = after, after
        else
            offset = offset + 1
        end
    end
    chunks[#chunks + 1] = source:sub(start)
    return table.concat(chunks)
end

local function referenceLabel(label, work)
    local decoded = unescape(label, work)
    return (trim(decoded):gsub("[ \t\r\n]+", " "):lower():gsub("[\194-\244][\128-\191]+", accents))
end

local function codeIndex(source, context)
    local groups, offset = {}, 1
    while true do
        context.checkpoint()
        local first, last = source:find(TICK .. "+", offset)
        if not first then
            break
        end
        local width = last - first + 1
        groups[width] = groups[width] or {}
        groups[width][#groups[width] + 1] = first
        offset = last + 1
    end
    return function(first, width)
        local starts = groups[width]
        if not starts then
            return nil
        end
        local left, right = 1, #starts
        while left <= right do
            local middle = math.floor((left + right) / 2)
            if starts[middle] > first + width - 1 then
                right = middle - 1
            else
                left = middle + 1
            end
        end
        return starts[left]
    end
end

local function bracketIndex(source, closingCode, context)
    local stack, result, offset = {}, {}, 1
    while offset <= #source do
        context.checkpoint()
        local char = source:sub(offset, offset)
        if char == "\\" then
            offset = offset + 2
        elseif char == TICK then
            local run = source:match("^" .. TICK .. "+", offset)
            local finish = closingCode(offset, #run)
            offset = finish and finish + #run or offset + #run
        else
            if char == "[" then
                stack[#stack + 1] = offset
            elseif char == "]" and #stack > 0 then
                result[stack[#stack]] = offset
                stack[#stack] = nil
            end
            offset = offset + 1
        end
    end
    return result
end

local function target(source, offset, context)
    if source:sub(offset, offset) ~= "(" then
        return nil
    end
    local at = offset + 1
    local function spaces()
        while source:sub(at, at):match("[ \t\n]") do
            context.checkpoint()
            at = at + 1
        end
    end
    spaces()
    local start, finish
    local depth = 0
    local destinationStart = at
    if source:sub(at, at) == "<" then
        at, destinationStart = at + 1, at + 1
        while at <= #source do
            context.checkpoint()
            local char = source:sub(at, at)
            if char == "\\" then
                at = at + 2
            elseif char == ">" then
                finish, at = at, at + 1
                break
            elseif char == "\n" or char == "<" then
                return nil
            else
                at = at + 1
            end
        end
        if not finish then
            return nil
        end
    else
        while at <= #source do
            context.checkpoint()
            local char = source:sub(at, at)
            if char == "\\" and escapable(source:sub(at + 1, at + 1)) then
                at = at + 2
            elseif char == "(" then
                depth, at = depth + 1, at + 1
                if depth > context.options.maxNesting then
                    error({
                        markdownLimit = true,
                        code = "max_nesting",
                        limit = context.options.maxNesting,
                    }, 0)
                end
            elseif char == ")" then
                if depth == 0 then
                    break
                end
                depth, at = depth - 1, at + 1
            elseif char:match("[ \t\n]") then
                break
            else
                at = at + 1
            end
        end
        if depth ~= 0 then
            return nil
        end
        finish = at
    end
    local before = at
    spaces()
    local title = ""
    local quote = source:sub(at, at)
    if at > before and (quote == '"' or quote == "'" or quote == "(") then
        local ending = quote == "(" and ")" or quote
        at, start = at + 1, at + 1
        local closed = false
        while at <= #source do
            context.checkpoint()
            local char = source:sub(at, at)
            if char == "\\" then
                at = at + 2
            elseif char == ending then
                title = unescape(source:sub(start, at - 1), context.checkpoint)
                at = at + 1
                closed = true
                break
            else
                at = at + 1
            end
        end
        if not closed then
            return nil
        end
        spaces()
    end
    if source:sub(at, at) ~= ")" then
        return nil
    end
    return unescape(source:sub(destinationStart, finish - 1), context.checkpoint), title, at + 1
end

local function flanking(source, first, after, marker)
    local left, right = previous(source, first), codepoint(source, after)
    local leftSpace, rightSpace = whitespace(left), whitespace(right)
    local leftPunctuation, rightPunctuation = punctuation(left), punctuation(right)
    local opens = not rightSpace and (not rightPunctuation or leftSpace or leftPunctuation)
    local closes = not leftSpace and (not leftPunctuation or rightSpace or rightPunctuation)
    if marker == "_" then
        return opens and (not closes or leftPunctuation), closes and (not opens or rightPunctuation)
    end
    return opens, closes
end

local function resolve(tokens, context)
    local live, byMarker = {}, {}
    for _, marker in ipairs({ "*", "_", "~" }) do
        byMarker[marker] = { {}, {}, {}, {}, {}, {} }
    end
    for index, token in ipairs(tokens) do
        context.checkpoint()
        if token.marker then
            token.remaining = token.width
            local groups = byMarker[token.marker]
            while token.canClose and token.remaining > 0 do
                context.checkpoint()
                -- Compatibility depends only on width modulo three and whether
                -- an opener can also close. Keeping those six groups avoids
                -- repeatedly scanning a long incompatible suffix of openers.
                local open
                for _, candidates in ipairs(groups) do
                    while #candidates > 0 and not candidates[#candidates].active do
                        context.checkpoint()
                        candidates[#candidates] = nil
                    end
                    local candidate = candidates[#candidates]
                    if candidate then
                        local ambiguous = token.marker ~= "~"
                            and (candidate.canClose or token.canOpen)
                            and (candidate.width + token.width) % 3 == 0
                            and (candidate.width % 3 ~= 0 or token.width % 3 ~= 0)
                        if not ambiguous and (not open or candidate.index > open.index) then
                            open = candidate
                        end
                    end
                end
                if not open then
                    break
                end
                while #live > 0 and live[#live] ~= open do
                    context.checkpoint()
                    live[#live].active = false
                    live[#live] = nil
                end
                local used = token.marker == "~" and 2
                    or math.min(open.remaining, token.remaining) >= 2 and 2
                    or 1
                local node = context.node(
                    token.marker == "~" and "strikethrough" or used == 2 and "strong" or "emph"
                )
                open.opens = open.opens or {}
                token.closes = token.closes or {}
                open.opens[#open.opens + 1], token.closes[#token.closes + 1] = node, node
                open.remaining, token.remaining = open.remaining - used, token.remaining - used
                if open.remaining == 0 then
                    open.active = false
                    live[#live] = nil
                end
            end
            if token.canOpen and token.remaining > 0 then
                token.active, token.index = true, index
                local candidates = groups[token.width % 3 * 2 + (token.canClose and 2 or 1)]
                live[#live + 1], candidates[#candidates + 1] = token, token
            end
        end
    end
    local root, stack = {}, {}
    local current = root
    for _, token in ipairs(tokens) do
        context.checkpoint()
        for _, node in ipairs(token.closes or {}) do
            assert(stack[#stack] and stack[#stack].node == node, "crossing inline spans")
            current = stack[#stack].parent
            stack[#stack] = nil
        end
        if token.marker then
            if token.remaining > 0 then
                current[#current + 1] =
                    context.node("text", { literal = string.rep(token.marker, token.remaining) })
            end
        else
            current[#current + 1] = token
        end
        for at = #(token.opens or {}), 1, -1 do
            local node = token.opens[at]
            current[#current + 1] = node
            stack[#stack + 1] = { node = node, parent = current }
            current = node.children
        end
    end
    assert(#stack == 0, "unclosed inline span")
    return root
end

local function nativeLinkEnd(source, offset)
    local link = source:match("^|cn[A-Za-z0-9_]+:()", offset)
        or source:match("^|c%x%x%x%x%x%x%x%x()", offset)
    local colored = link ~= nil
    link = link or offset
    if source:sub(link, link + 1) ~= "|H" then
        return nil
    end
    local separator = source:find("|", link + 2, true)
    if not separator or separator == link + 2 or source:sub(separator, separator + 1) ~= "|h" then
        return nil
    end
    local ending = source:find("|h", separator + 2, true)
    if not ending then
        return nil
    end
    local after = ending + 2
    if colored then
        if source:sub(after, after + 1) ~= "|r" then
            return nil
        end
        after = after + 2
    end
    if after - offset > 4096 or source:sub(offset, after - 1):find("[\r\n]") then
        return nil
    end
    return after
end

local function inline(source, context, nesting, allowLinks)
    nesting = nesting or 0
    if nesting > context.options.maxNesting then
        error({ markdownLimit = true, code = "max_nesting", limit = context.options.maxNesting }, 0)
    end
    local tokens, offset = {}, 1
    local closingCode = codeIndex(source, context)
    local brackets = bracketIndex(source, closingCode, context)
    local function emit(kind, fields)
        tokens[#tokens + 1] = context.node(kind, fields)
    end
    while offset <= #source do
        context.checkpoint()
        local char, consumed = source:sub(offset, offset), false
        if char == "\\" then
            local after = source:sub(offset + 1, offset + 1)
            if after == "\n" then
                emit("linebreak")
                offset, consumed = offset + 2, true
            elseif escapable(after) then
                emit("text", { literal = after })
                offset, consumed = offset + 2, true
            end
        elseif char == TICK then
            local marker = source:match("^" .. TICK .. "+", offset)
            local finish = closingCode(offset, #marker)
            if finish then
                local value = source:sub(offset + #marker, finish - 1):gsub("\n", " ")
                if value:sub(1, 1) == " " and value:sub(-1) == " " and value:find("[^ ]") then
                    value = value:sub(2, -2)
                end
                emit("code", { literal = value })
                offset = finish + #marker
            else
                emit("text", { literal = marker })
                offset = offset + #marker
            end
            consumed = true
        elseif char == "|" then
            local after = nativeLinkEnd(source, offset)
            if after then
                emit("native_link", { literal = source:sub(offset, after - 1) })
                offset, consumed = after, true
            end
        elseif char == "\n" then
            local last = tokens[#tokens]
            local hard = last and last.type == "text" and last.literal:match("  $")
            if last and last.type == "text" then
                last.literal = last.literal:gsub(" +$", "")
            end
            emit(hard and "linebreak" or "softbreak")
            offset = offset + 1
            while source:sub(offset, offset) == " " do
                offset = offset + 1
            end
            consumed = true
        elseif char == "*" or char == "_" or char == "~" then
            local run = source:match("^" .. (char == "*" and "%*" or char) .. "+", offset)
            local opens, closes = flanking(source, offset, offset + #run, char)
            if char == "~" and #run ~= 2 then
                opens, closes = false, false
            end
            tokens[#tokens + 1] =
                { marker = char, width = #run, canOpen = opens, canClose = closes }
            offset, consumed = offset + #run, true
        elseif char == "[" and context.options.references then
            local key, after = source:match("^%[%[ref:([A-Za-z][A-Za-z0-9_%-]*)%]%]()", offset)
            if key and #key <= 64 then
                emit("reference", { key = key, literal = source:sub(offset, after - 1) })
                offset, consumed = after, true
            else
                local tail = #source - offset + 1 <= 71 and source:sub(offset) or ""
                local marker = "[[ref:"
                local partial = #tail <= 71
                    and tail:sub(1, 2) == "[["
                    and (
                        #tail <= #marker and marker:sub(1, #tail) == tail
                        or tail:match("^%[%[ref:[A-Za-z][A-Za-z0-9_%-]*%]?$")
                    )
                if partial then
                    emit("reference_pending", { literal = tail })
                    offset, consumed = #source + 1, true
                end
            end
        elseif char == "&" then
            local value, after = entityAt(source, offset)
            if value then
                emit("text", { literal = value })
                offset, consumed = after, true
            end
        elseif char == "<" then
            local destination, after =
                source:match("^<([A-Za-z][A-Za-z0-9+%.%-]*:[^<> \t\n]+)>()", offset)
            if destination and allowLinks ~= false then
                emit("link", {
                    destination = destination,
                    title = "",
                    children = { context.node("text", { literal = destination }) },
                })
                offset, consumed = after, true
            else
                local html, ending = source:match("^(</?[A-Za-z][^<>\n]*>)()", offset)
                if html then
                    emit("html_inline", { literal = html })
                    offset, consumed = ending, true
                end
            end
        end
        if
            not consumed
            and (
                char == "!" and source:sub(offset + 1, offset + 1) == "["
                or allowLinks ~= false and char == "["
            )
        then
            local open = char == "!" and offset + 1 or offset
            local close = brackets[open]
            if close then
                local destination, title, after = target(source, close + 1, context)
                if not destination and next(context.references) then
                    local label, endLabel = source:match("^%[([^%]\n]*)%]()", close + 1)
                    local key = label and label ~= "" and label
                        or close - open <= 1025 and source:sub(open + 1, close - 1)
                    local known = key
                        and #key <= 1024
                        and context.references[referenceLabel(key, context.checkpoint)]
                    if known then
                        destination, title, after =
                            known.destination, known.title, endLabel or close + 1
                    end
                end
                if destination then
                    emit(char == "!" and "image" or "link", {
                        destination = destination,
                        title = title or "",
                        children = inline(
                            source:sub(open + 1, close - 1),
                            context,
                            nesting + 1,
                            false
                        ),
                    })
                    offset, consumed = after, true
                end
            end
        end
        if not consumed then
            local first = source:find("[\\" .. TICK .. "\n*_~%[!&<|]", offset + 1)
            local after = first or #source + 1
            emit("text", { literal = source:sub(offset, after - 1) })
            offset = after
        end
    end
    return resolve(tokens, context)
end

M._syntax = {
    trim = trim,
    utf8 = utf8,
    codepoint = codepoint,
    referenceLabel = referenceLabel,
    unescape = unescape,
    inline = inline,
}
