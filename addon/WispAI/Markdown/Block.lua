local _, C = ...
local M = C.Markdown

-- Wisp's block grammar is deliberately small. Each recursive container keeps
-- records pointing into the original document, so stripping a quote or list
-- prefix never loses the location of its contents.
function M._blocks(source, context)
    local work = 0
    local function tick()
        work = work + 1
        if work >= 32 then
            work = 0
            context.checkpoint()
        end
    end

    local function blank(text)
        return text:match("^[ \t]*$") ~= nil
    end

    local function trim(text)
        return (text:gsub("^[ \t]+", ""):gsub("[ \t]+$", ""))
    end

    local function indent(text, column)
        local width, p = 0, 1
        while p <= #text do
            local ch = text:sub(p, p)
            if ch == " " then
                width = width + 1
            elseif ch == "\t" then
                width = width + 4 - ((column or 1) - 1 + width) % 4
            else
                break
            end
            p = p + 1
            tick()
        end
        return width, p
    end

    local function endColumn(text, start)
        local col = start or 1
        for p = 1, #text do
            if text:sub(p, p) == "\t" then
                col = col + 4 - (col - 1) % 4
            else
                col = col + 1
            end
            tick()
        end
        return math.max(start or 1, col - 1)
    end

    local function strip(record, count)
        local width, p = 0, 1
        local text = record.text
        while width < count and p <= #text do
            local ch = text:sub(p, p)
            local nextWidth
            if ch == " " then
                nextWidth = width + 1
            elseif ch == "\t" then
                nextWidth = width + 4 - (record.column - 1 + width) % 4
            else
                break
            end
            p = p + 1
            if nextWidth > count then
                return {
                    text = string.rep(" ", nextWidth - count) .. text:sub(p),
                    line = record.line,
                    column = record.column + count,
                    finish = record.finish,
                }
            end
            width = nextWidth
            tick()
        end
        return {
            text = text:sub(p),
            line = record.line,
            column = record.column + width,
            finish = record.finish,
        }
    end

    local function shift(record, bytes)
        return {
            text = record.text:sub(bytes + 1),
            line = record.line,
            column = record.column + bytes,
            finish = record.finish,
        }
    end

    local function position(first, last, offset)
        local start = first.column + (offset or 0)
        return {
            { first.line, start },
            { last.line, math.max(last.column, last.finish) },
        }
    end

    local function node(kind, fields, first, last, offset)
        fields = fields or {}
        fields.children = fields.children or {}
        if first then
            fields.sourcepos = position(first, last or first, offset)
        end
        tick()
        return context.node(kind, fields)
    end

    local records = {}
    source = source:gsub("\r\n", "\n"):gsub("\r", "\n"):gsub("%z", "\239\191\189")
    local start, line = 1, 1
    while start <= #source do
        local stop = source:find("\n", start, true)
        local text = source:sub(start, stop and stop - 1 or #source)
        records[#records + 1] =
            { text = text, line = line, column = 1, finish = endColumn(text, 1) }
        if not stop then
            break
        end
        start, line = stop + 1, line + 1
        tick()
    end

    local function core(record)
        local width, p = indent(record.text, record.column)
        if width > 3 then
            return nil
        end
        return record.text:sub(p), width
    end

    local function thematic(record)
        local text = core(record)
        if not text then
            return false
        end
        text = text:gsub("[ \t]", "")
        local ch = text:sub(1, 1)
        return #text >= 3
            and (ch == "-" or ch == "*" or ch == "_")
            and text == string.rep(ch, #text)
    end

    local function setext(record)
        local text = core(record)
        if not text then
            return nil
        end
        text = trim(text)
        if text:match("^=+$") then
            return 1
        end
        if text:match("^-+$") then
            return 2
        end
    end

    local function heading(record)
        local text, width = core(record)
        if not text then
            return nil
        end
        local hashes, tail = text:match("^(#+)(.*)$")
        if not hashes or #hashes > 6 or (tail ~= "" and not tail:match("^[ \t]")) then
            return nil
        end
        tail = tail:gsub("[ \t]+#+[ \t]*$", "")
        return #hashes, trim(tail), width
    end

    local function fence(record)
        local text, width = core(record)
        if not text then
            return nil
        end
        local ch = text:sub(1, 1)
        if ch ~= "`" and ch ~= "~" then
            return nil
        end
        local p = 1
        while text:sub(p, p) == ch do
            p = p + 1
            tick()
        end
        if p <= 3 then
            return nil
        end
        local info = trim(text:sub(p))
        if ch == "`" and info:find("`", 1, true) then
            return nil
        end
        return ch, p - 1, info, width
    end

    local function closesFence(record, ch, length)
        local text = core(record)
        if not text then
            return false
        end
        local p = 1
        while text:sub(p, p) == ch do
            p = p + 1
            tick()
        end
        return p - 1 >= length and blank(text:sub(p))
    end

    local function quote(record)
        local text, width = core(record)
        if not text or text:sub(1, 1) ~= ">" then
            return nil
        end
        local result = shift(strip(record, width), 1)
        if result.text:match("^[ \t]") then
            result = strip(result, 1)
        end
        return result, width
    end

    local function marker(record)
        local text, width = core(record)
        if not text then
            return nil
        end
        local symbol = text:sub(1, 1)
        local ordered, number, markerWidth, delimiter
        if symbol == "-" or symbol == "+" or symbol == "*" then
            ordered, markerWidth, delimiter = false, 1, symbol
        else
            local digits, ending = text:match("^(%d+)([.)])")
            if not digits or #digits > 9 then
                return nil
            end
            ordered, number, markerWidth, delimiter = true, tonumber(digits), #digits + 1, ending
        end
        local after = text:sub(markerWidth + 1)
        if after ~= "" and not after:match("^[ \t]") then
            return nil
        end
        local whitespace, p = 0, 1
        while p <= #after do
            local ch = after:sub(p, p)
            if ch == " " then
                whitespace = whitespace + 1
            elseif ch == "\t" then
                whitespace = whitespace
                    + 4
                    - (record.column - 1 + width + markerWidth + whitespace) % 4
            else
                break
            end
            p = p + 1
            tick()
        end
        local padding = whitespace >= 1 and whitespace <= 4 and whitespace or 1
        local contentIndent = width + markerWidth + padding
        local content = strip(record, width)
        content = shift(content, markerWidth)
        content = strip(content, padding)
        if after == "" then
            content.column = record.column + contentIndent
        end
        return {
            ordered = ordered,
            start = number,
            delimiter = delimiter,
            indent = width,
            contentIndent = contentIndent,
            content = content,
            empty = blank(after),
        }
    end

    local function interrupts(record, inParagraph)
        if heading(record) or fence(record) or quote(record) or thematic(record) then
            return true
        end
        local item = marker(record)
        if
            item and (not inParagraph or (not item.empty and (not item.ordered or item.start == 1)))
        then
            return true
        end
        return false
    end

    local decode = context.unescape

    local function title(text)
        local opening = text:sub(1, 1)
        local closing = opening == "(" and ")" or opening
        if opening ~= '"' and opening ~= "'" and opening ~= "(" then
            return nil
        end
        local p, escaped = 2, false
        while p <= #text do
            local ch = text:sub(p, p)
            if not escaped and ch == closing then
                if blank(text:sub(p + 1)) then
                    return decode(text:sub(2, p - 1))
                end
                return nil
            end
            if ch == "\\" and not escaped then
                escaped = true
            else
                escaped = false
            end
            p = p + 1
            tick()
        end
    end

    local function reference(rows, index)
        local text = core(rows[index])
        if not text or text:sub(1, 1) ~= "[" then
            return nil
        end
        local close, p, escaped = nil, 2, false
        while p <= #text and p <= 1001 do
            local ch = text:sub(p, p)
            if ch == "]" and not escaped then
                close = p
                break
            end
            if ch == "[" and not escaped then
                return nil
            end
            if ch == "\\" and not escaped then
                escaped = true
            else
                escaped = false
            end
            p = p + 1
            tick()
        end
        if not close or text:sub(close + 1, close + 1) ~= ":" then
            return nil
        end
        local label = text:sub(2, close - 1)
        if blank(label) then
            return nil
        end
        local rest, consumed = trim(text:sub(close + 2)), 1
        if rest == "" and rows[index + 1] and not blank(rows[index + 1].text) then
            rest, consumed = trim(rows[index + 1].text), 2
        end
        local destination, tail
        if rest:sub(1, 1) == "<" then
            local q, slash = 2, false
            while q <= #rest do
                local ch = rest:sub(q, q)
                if ch == ">" and not slash then
                    destination, tail = rest:sub(2, q - 1), trim(rest:sub(q + 1))
                    break
                end
                if ch == "<" and not slash then
                    return nil
                end
                if ch == "\\" and not slash then
                    slash = true
                else
                    slash = false
                end
                q = q + 1
                tick()
            end
        else
            local q, balance, slash = 1, 0, false
            while q <= #rest do
                local ch = rest:sub(q, q)
                if not slash then
                    if ch:match("[ \t]") then
                        break
                    end
                    if ch == "(" then
                        balance = balance + 1
                    end
                    if ch == ")" then
                        balance = balance - 1
                    end
                    if balance < 0 or balance > 32 or ch == "<" or ch:byte() < 32 then
                        return nil
                    end
                end
                if ch == "\\" and not slash then
                    slash = true
                else
                    slash = false
                end
                q = q + 1
                tick()
            end
            if q > 1 and balance == 0 then
                destination, tail = rest:sub(1, q - 1), trim(rest:sub(q))
            end
        end
        if not destination then
            return nil
        end
        local caption
        if tail ~= "" then
            caption = title(tail)
            if caption == nil then
                return nil
            end
        elseif rows[index + consumed] then
            caption = title(trim(rows[index + consumed].text))
            if caption ~= nil then
                consumed = consumed + 1
            end
        end
        local key
        if context.referenceLabel then
            key = context.referenceLabel(label)
        else
            key = label:lower():gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
        end
        if not key or key == "" then
            return nil
        end
        context.references = context.references or {}
        if not context.references[key] then
            context.references[key] = { destination = decode(destination), title = caption or "" }
        end
        return consumed
    end

    -- A pipe escaped by an odd backslash run belongs to its cell, including
    -- inside a code span. Remove that one escape before the inline pass.
    local function cells(record)
        local text, parts, buffer = record.text, {}, {}
        local p, startAt, hasPipe = 1, 1, false
        local function finish(stop)
            local raw = table.concat(buffer)
            local leading = #(raw:match("^[ \t]*") or "")
            parts[#parts + 1] = {
                text = trim(raw),
                column = record.column + startAt - 1 + leading,
                finish = record.column + math.max(startAt - 1, stop - 1),
                line = record.line,
            }
            buffer = {}
        end
        while p <= #text do
            local ch = text:sub(p, p)
            if ch == "\\" then
                local q = p
                while text:sub(q, q) == "\\" do
                    q = q + 1
                    tick()
                end
                local count = q - p
                if text:sub(q, q) == "|" and count % 2 == 1 then
                    buffer[#buffer + 1] = string.rep("\\", count - 1) .. "|"
                    p = q + 1
                else
                    buffer[#buffer + 1] = text:sub(p, q - 1)
                    p = q
                end
            elseif ch == "|" then
                hasPipe = true
                finish(p - 1)
                p, startAt = p + 1, p + 1
            else
                buffer[#buffer + 1] = ch
                p = p + 1
            end
            tick()
        end
        finish(#text)
        if hasPipe and text:match("^[ \t]*|") then
            table.remove(parts, 1)
        end
        if hasPipe and text:match("|[ \t]*$") and parts[#parts].text == "" then
            table.remove(parts)
        end
        return parts, hasPipe
    end

    local function tableHeader(rows, index)
        if not rows[index + 1] then
            return nil
        end
        local header, headerPipe = cells(rows[index])
        local separator, separatorPipe = cells(rows[index + 1])
        if not (headerPipe or separatorPipe) or #header == 0 or #header ~= #separator then
            return nil
        end
        local alignment = {}
        for p = 1, #separator do
            local text = separator[p].text
            local middle = text:gsub("^:", ""):gsub(":$", "")
            if #middle < 3 or not middle:match("^%-+$") then
                return nil
            end
            local left, right = text:sub(1, 1) == ":", text:sub(-1) == ":"
            alignment[p] = left and right and "center"
                or left and "left"
                or right and "right"
                or false
            tick()
        end
        return header, alignment
    end

    -- Lazy container continuations are permitted only while its last block is
    -- a paragraph. Remember opaque code and tables while collecting records;
    -- their ordinary-looking lines must not reopen that permission.
    local function lazyTracker()
        local state = { paragraph = false }
        function state.consume(record)
            if state.fenceChar then
                if closesFence(record, state.fenceChar, state.fenceSize) then
                    state.fenceChar = nil
                end
                state.paragraph, state.previous = false, nil
                return
            end
            if blank(record.text) then
                state.paragraph, state.tableActive, state.previous = false, false, nil
                return
            end
            if state.tableActive then
                if not interrupts(record, false) and indent(record.text, record.column) < 4 then
                    return
                end
                state.tableActive = false
            end
            local ch, size = fence(record)
            if ch then
                state.fenceChar, state.fenceSize, state.paragraph, state.previous =
                    ch, size, false, nil
                return
            end
            if state.previous and tableHeader({ state.previous, record }, 1) then
                state.paragraph, state.tableActive, state.previous = false, true, nil
                return
            end
            if
                interrupts(record, false)
                or (indent(record.text, record.column) >= 4 and not state.paragraph)
            then
                state.paragraph, state.previous = false, nil
                return
            end
            if state.paragraph and setext(record) then
                state.paragraph, state.previous = false, nil
                return
            end
            local text = core(record)
            if text and text:match("^%[.-%]:") then
                state.paragraph, state.previous = false, nil
                return
            end
            state.paragraph, state.previous = true, record
        end
        return state
    end

    local maxNesting = context.options and context.options.maxNesting or 64
    local parse
    parse = function(rows, depth)
        local result, i = {}, 1
        local function append(value)
            result[#result + 1] = value
        end
        while i <= #rows do
            tick()
            local record = rows[i]
            if blank(record.text) then
                i = i + 1
            else
                local refCount = reference(rows, i)
                local level, text, headingIndent = heading(record)
                local fenceChar, fenceSize, info, fenceIndent = fence(record)
                local quoted, quoteIndent = quote(record)
                local itemMarker = marker(record)
                local header, alignment
                if rows[i + 1] and not blank(rows[i + 1].text) then
                    header, alignment = tableHeader(rows, i)
                end
                if refCount then
                    i = i + refCount
                elseif fenceChar then
                    local j, lines, last = i + 1, {}, record
                    while j <= #rows and not closesFence(rows[j], fenceChar, fenceSize) do
                        lines[#lines + 1] = strip(rows[j], fenceIndent).text .. "\n"
                        last, j = rows[j], j + 1
                        tick()
                    end
                    if j <= #rows then
                        last, j = rows[j], j + 1
                    end
                    append(
                        node(
                            "code_block",
                            { literal = table.concat(lines), info = decode(info) },
                            record,
                            last,
                            fenceIndent
                        )
                    )
                    i = j
                elseif level then
                    append(
                        node(
                            "heading",
                            { level = level, _inline = text },
                            record,
                            record,
                            headingIndent
                        )
                    )
                    i = i + 1
                elseif thematic(record) then
                    local _, initial = core(record)
                    append(node("thematic_break", nil, record, record, initial))
                    i = i + 1
                elseif quoted then
                    if depth >= maxNesting then
                        error({ markdownLimit = true, code = "max_nesting", limit = maxNesting }, 0)
                    end
                    local inside, j, tracker = {}, i, lazyTracker()
                    while j <= #rows do
                        local content = quote(rows[j])
                        if content then
                            inside[#inside + 1] = content
                            tracker.consume(content)
                        elseif
                            tracker.paragraph
                            and not blank(rows[j].text)
                            and not interrupts(rows[j], true)
                        then
                            inside[#inside + 1] = rows[j]
                            tracker.consume(rows[j])
                        else
                            break
                        end
                        j = j + 1
                        tick()
                    end
                    append(
                        node(
                            "block_quote",
                            { children = parse(inside, depth + 1) },
                            record,
                            rows[j - 1],
                            quoteIndent
                        )
                    )
                    i = j
                elseif itemMarker then
                    if depth >= maxNesting then
                        error({ markdownLimit = true, code = "max_nesting", limit = maxNesting }, 0)
                    end
                    local list = node(
                        "list",
                        { ordered = itemMarker.ordered, start = itemMarker.start, tight = true },
                        record,
                        record,
                        itemMarker.indent
                    )
                    local listMarker, j, last = itemMarker, i, record
                    while j <= #rows do
                        local current = marker(rows[j])
                        if
                            thematic(rows[j])
                            or not current
                            or current.indent ~= listMarker.indent
                            or current.ordered ~= listMarker.ordered
                            or current.delimiter ~= listMarker.delimiter
                        then
                            break
                        end
                        local first, inside, k = rows[j], { current.content }, j + 1
                        local hadBlank, tracker = false, lazyTracker()
                        tracker.consume(current.content)
                        local lastContent = first
                        while k <= #rows do
                            local nextRecord = rows[k]
                            local nextMarker = marker(nextRecord)
                            local width = indent(nextRecord.text, nextRecord.column)
                            if nextMarker and nextMarker.indent <= listMarker.indent then
                                break
                            end
                            if blank(nextRecord.text) then
                                inside[#inside + 1] = nextRecord
                                hadBlank = true
                                tracker.consume(nextRecord)
                            elseif width >= current.contentIndent then
                                local content = strip(nextRecord, current.contentIndent)
                                inside[#inside + 1] = content
                                lastContent, hadBlank = nextRecord, false
                                tracker.consume(content)
                            elseif
                                not hadBlank
                                and tracker.paragraph
                                and not interrupts(nextRecord, true)
                            then
                                inside[#inside + 1] = nextRecord
                                lastContent = nextRecord
                                tracker.consume(nextRecord)
                            else
                                break
                            end
                            k = k + 1
                            tick()
                        end
                        local nextMarker = rows[k] and not thematic(rows[k]) and marker(rows[k])
                        local sibling = nextMarker
                            and nextMarker.indent == listMarker.indent
                            and nextMarker.ordered == listMarker.ordered
                            and nextMarker.delimiter == listMarker.delimiter
                        if hadBlank and sibling then
                            list.tight = false
                        end
                        while #inside > 1 and blank(inside[#inside].text) do
                            table.remove(inside)
                        end
                        local state, rest = inside[1].text:match("^%[([ xX])%]([ \t].*)$")
                        if not state then
                            state = inside[1].text:match("^%[([ xX])%]$")
                            rest = state and "" or nil
                        end
                        local fields = {}
                        if state then
                            local removed = 3 + #(rest:match("^[ \t]*") or "")
                            inside[1] = shift(inside[1], removed)
                            fields.task, fields.checked = true, state ~= " "
                        end
                        fields.children = parse(inside, depth + 1)
                        local scan = 1
                        for childIndex = 2, #fields.children do
                            local before = fields.children[childIndex - 1].sourcepos[2][1]
                            local after = fields.children[childIndex].sourcepos[1][1]
                            while inside[scan] and inside[scan].line < after do
                                if inside[scan].line > before and blank(inside[scan].text) then
                                    list.tight = false
                                end
                                scan = scan + 1
                                tick()
                            end
                        end
                        list.children[#list.children + 1] =
                            node("item", fields, first, lastContent, current.indent)
                        last, j = lastContent, k
                        if not sibling then
                            break
                        end
                    end
                    list.sourcepos = position(record, last, listMarker.indent)
                    append(list)
                    i = j
                elseif indent(record.text, record.column) >= 4 then
                    local lines, j, last, lastNonblank = {}, i, record, 0
                    while j <= #rows do
                        if blank(rows[j].text) then
                            lines[#lines + 1] = "\n"
                        elseif indent(rows[j].text, rows[j].column) >= 4 then
                            lines[#lines + 1] = strip(rows[j], 4).text .. "\n"
                            lastNonblank, last = #lines, rows[j]
                        else
                            break
                        end
                        j = j + 1
                        tick()
                    end
                    while #lines > lastNonblank do
                        table.remove(lines)
                    end
                    append(
                        node(
                            "code_block",
                            { literal = table.concat(lines), info = "" },
                            strip(record, 4),
                            last
                        )
                    )
                    i = j
                elseif header then
                    local tableNode = node("table", { align = alignment }, record, rows[i + 1])
                    local function addRow(parts, rowRecord, isHeader)
                        local row = node("table_row", { header = isHeader }, rowRecord, rowRecord)
                        for p = 1, #alignment do
                            local cell = parts[p]
                                or {
                                    text = "",
                                    line = rowRecord.line,
                                    column = rowRecord.finish,
                                    finish = rowRecord.finish,
                                }
                            row.children[#row.children + 1] = node("table_cell", {
                                _inline = cell.text,
                                header = isHeader,
                                align = alignment[p],
                            }, cell, cell)
                            tick()
                        end
                        tableNode.children[#tableNode.children + 1] = row
                    end
                    addRow(header, record, true)
                    local j, last = i + 2, rows[i + 1]
                    while
                        j <= #rows
                        and not blank(rows[j].text)
                        and not interrupts(rows[j], false)
                        and indent(rows[j].text, rows[j].column) < 4
                    do
                        local parts = cells(rows[j])
                        addRow(parts, rows[j], false)
                        last, j = rows[j], j + 1
                        tick()
                    end
                    tableNode.sourcepos = position(record, last)
                    append(tableNode)
                    i = j
                else
                    local lines, j, last, underline = {}, i, record, nil
                    while j <= #rows and not blank(rows[j].text) do
                        if j > i then
                            underline = setext(rows[j])
                            if underline then
                                break
                            end
                            if interrupts(rows[j], true) then
                                break
                            end
                            if rows[j + 1] and tableHeader(rows, j) then
                                break
                            end
                        end
                        local width = indent(rows[j].text, rows[j].column)
                        lines[#lines + 1] = strip(rows[j], math.min(width, 3)).text
                        last, j = rows[j], j + 1
                        tick()
                    end
                    local width = indent(record.text, record.column)
                    local first = strip(record, math.min(width, 3))
                    if underline then
                        append(
                            node(
                                "heading",
                                { level = underline, _inline = table.concat(lines, "\n") },
                                first,
                                rows[j]
                            )
                        )
                        i = j + 1
                    else
                        append(
                            node("paragraph", { _inline = table.concat(lines, "\n") }, first, last)
                        )
                        i = j
                    end
                end
            end
        end
        return result
    end

    local document = node("document", { children = parse(records, 0) })
    document.sourcepos = #records > 0 and position(records[1], records[#records])
        or { { 1, 1 }, { 1, 1 } }
    return document
end
