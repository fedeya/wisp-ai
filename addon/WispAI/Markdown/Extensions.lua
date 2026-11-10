local _, C = ...
local M = C.Markdown
local U = M.Scanner
local E = {}
M.Extensions = E

-- GFM table cells have their own escape pass: \| is a cell character even
-- inside code spans. Other escapes are left for the normal inline parser.
function E.cells(line)
    line = U.trim(line)
    local cells, chunks, pos, hasPipe = {}, {}, 1, false
    if line:sub(1, 1) == "|" then
        pos, hasPipe = 2, true
    end
    local trailing = false
    while pos <= #line do
        local char = line:sub(pos, pos)
        if char == "\\" then
            local nextChar = line:sub(pos + 1, pos + 1)
            if nextChar == "|" then
                chunks[#chunks + 1], pos = "|", pos + 2
            elseif nextChar == "\\" then
                chunks[#chunks + 1], pos = "\\\\", pos + 2
            else
                chunks[#chunks + 1], pos = char, pos + 1
            end
            trailing = false
        elseif char == "|" then
            cells[#cells + 1] = U.trim(table.concat(chunks))
            chunks, pos, hasPipe, trailing = {}, pos + 1, true, true
        else
            local first = line:find("[|\\]", pos) or (#line + 1)
            chunks[#chunks + 1] = line:sub(pos, first - 1)
            pos, trailing = first, false
        end
    end
    if not trailing then
        cells[#cells + 1] = U.trim(table.concat(chunks))
    end
    return cells, hasPipe
end

function E.tableHeader(header, delimiter)
    local cells, hasPipe = E.cells(header)
    if not hasPipe then
        return
    end
    local markers = E.cells(delimiter)
    if #markers ~= #cells or #markers == 0 then
        return
    end
    local align = {}
    for i, marker in ipairs(markers) do
        if not marker:match("^:?-+:?$") then
            return
        end
        align[i] = marker:sub(1, 1) == ":" and (marker:sub(-1) == ":" and "center" or "left")
            or (marker:sub(-1) == ":" and "right" or false)
    end
    return cells, align
end

function E.tableRow(parser, node, cells, header, lineNumber, column, lastColumn)
    local section = header and node.firstChild or node.lastChild
    if not section or (not header and section.type ~= "table_body") then
        section = parser:newNode(header and "table_head" or "table_body")
        node:appendChild(section)
    end
    local row = section:appendChild(
        parser:newNode(
            "table_row",
            { { lineNumber, column }, { lineNumber, lastColumn or #parser.line } }
        )
    )
    for i = 1, #node.align do
        local cell = row:appendChild(parser:newNode("table_cell"))
        cell._content, cell.header, cell.align = cells[i] or "", header, node.align[i] or nil
    end
end

function E.startTable(parser, container)
    if container.type ~= "paragraph" then
        return false
    end
    local lines = container._lines
    if not lines or #lines == 0 then
        return false
    end
    local header, align = E.tableHeader(lines[#lines], parser.line:sub(parser.nonspace))
    if not header then
        return false
    end
    parser:closeUnmatched()
    local location = container._lineSource[#lines]
    local node = parser:newNode("table", { { parser.lineNumber - 1, location.column }, { 0, 0 } })
    node.align, node._depth = align, container._depth
    if #lines > 1 then
        table.remove(lines)
        container._content = nil
        local lastLength = parser.lastLength
        parser.lastLength = container._lineSource[#lines].length
        parser:finalize(container, parser.lineNumber - 2)
        parser.lastLength = lastLength
        container:insertAfter(node)
    else
        container:insertAfter(node)
        container:unlink()
    end
    parser.tip = node
    E.tableRow(parser, node, header, true, parser.lineNumber - 1, location.column, location.length)
    parser:advance(#parser.line - parser.offset + 1, false)
    return true
end

function E.task(node)
    if
        node.type ~= "paragraph"
        or not node.parent
        or node.parent.type ~= "item"
        or node.parent.firstChild ~= node
    then
        return
    end
    local marker, body = node._content:match("^[ \t]*%[([ xX])%][ \t\n]+(.*)$")
    if marker then
        node.parent.task, node.parent.checked = true, marker:lower() == "x"
        node._content = body
    end
end

local function trimURL(value)
    local _, opening = value:gsub("%(", "")
    local _, closing = value:gsub("%)", "")
    local ending = #value
    while ending > 0 do
        local last = value:sub(ending, ending)
        if last == ")" and closing > opening then
            ending, closing = ending - 1, closing - 1
        elseif last:match("[?!%.,:%*_~'\"]") then
            ending = ending - 1
        elseif last == ";" then
            local start = ending - 1
            while start > 0 and value:sub(start, start):match("[A-Za-z]") do
                start = start - 1
            end
            ending = start < ending - 1 and value:sub(start, start) == "&" and start - 1
                or ending - 1
        else
            break
        end
    end
    return value:sub(1, ending)
end

-- Candidate discovery is independent of parsing. It prevents repeatedly
-- searching a suffix when code spans, brackets or failed URLs consume input.
function E.urlCandidates(source)
    local candidates = {}
    local position = 1
    while true do
        local colon = source:find("://", position, true)
        if not colon then
            break
        end
        local start = colon
        while start > position and source:sub(start - 1, start - 1):match("[A-Za-z]") do
            start = start - 1
        end
        local scheme = source:sub(start, colon - 1)
        local lower = scheme:lower()
        if lower == "http" or lower == "https" or lower == "ftp" then
            candidates[#candidates + 1] = { start = start, length = #scheme + 3 }
        end
        position = colon + 3
    end
    for start in source:gmatch("()www%.") do
        local previous = start > 1 and U.previous(source, start) or nil
        if
            not previous
            or U.whitespace(previous)
            or source:sub(start - 1, start - 1):match("[*_~(]")
        then
            candidates[#candidates + 1] = { start = start, www = true, length = 0 }
        end
    end
    table.sort(candidates, function(a, b)
        return a.start < b.start
    end)
    return candidates
end

function E.url(parser, candidate)
    local source = parser.subject
    local first = candidate.start
    if parser.urlSkipUntil and first < parser.urlSkipUntil then
        return
    end
    local domainStart, domainEnd = first + candidate.length, first + candidate.length
    while domainEnd <= #source do
        local code, nextPos = U.codepoint(source, domainEnd)
        if
            U.whitespace(code)
            or (
                code ~= 45
                and code ~= 95
                and code ~= 46
                and U.inRanges(code, M.Data.unicodePunctuation)
            )
        then
            break
        end
        domainEnd = nextPos
    end
    local domain = source:sub(domainStart, domainEnd - 1):gsub("%.+$", "")
    if domain == "" then
        return
    end
    local firstCode = U.codepoint(domain, 1)
    if
        not candidate.www
        and (U.whitespace(firstCode) or U.inRanges(firstCode, M.Data.unicodePunctuation))
    then
        return
    end
    local segments, pos = {}, 1
    while pos <= #domain do
        local char = domain:sub(pos, pos)
        if char == "." then
            pos = pos + 1
        else
            local last = domain:find(".", pos, true) or (#domain + 1)
            local segment = domain:sub(pos, last - 1)
            local index = 1
            while index <= #segment do
                local code, nextPos = U.codepoint(segment, index)
                if
                    U.whitespace(code)
                    or (code ~= 45 and code ~= 95 and U.inRanges(code, M.Data.unicodePunctuation))
                then
                    return
                end
                index = nextPos
            end
            segments[#segments + 1], pos = segment, last + 1
        end
    end
    if candidate.www and #segments < 2 then
        return
    end
    for i = math.max(1, #segments - 1), #segments do
        if segments[i]:find("_", 1, true) then
            local last, from = nil, 1
            while true do
                local found = domain:find("_", from, true)
                if not found then
                    break
                end
                last, from = found, found + 1
            end
            parser.urlSkipUntil = domainStart + last
            return
        end
    end
    local stop = parser.urlStop
    if not stop or first >= stop then
        stop = source:find("[ \t\r\n\f\v<]", first) or (#source + 1)
        parser.urlStop = stop
    end
    local value = trimURL(source:sub(first, stop - 1))
    return value, U.normalizeURI((candidate.www and "http://" or "") .. value), first + #value
end

local function emailNodes(parser, node)
    local source, position, emitted = node.literal, 1, 1
    local changed = false
    while true do
        local at = source:find("@", position, true)
        if not at then
            break
        end
        local start = at
        while start > position and source:sub(start - 1, start - 1):match("[A-Za-z0-9%.+_%-]") do
            start = start - 1
        end
        local protocol
        for _, prefix in ipairs({ "mailto:", "xmpp:" }) do
            local first = start - #prefix
            if
                first >= position
                and source:sub(first, start - 1) == prefix
                and (first == 1 or not source:sub(first - 1, first - 1):match("[A-Za-z0-9]"))
            then
                start, protocol = first, prefix
                break
            end
        end
        local ending, dots = at + 1, 0
        while ending <= #source do
            local char = source:sub(ending, ending)
            if char:match("[A-Za-z0-9]") or char == "-" or char == "_" then
                ending = ending + 1
            elseif char == "." and source:sub(ending + 1, ending + 1):match("[A-Za-z0-9]") then
                dots, ending = dots + 1, ending + 1
            else
                break
            end
        end
        if source:sub(ending, ending) == "@" then
            position = at + 1
        elseif start < at and dots > 0 and source:sub(ending - 1, ending - 1):match("[A-Za-z]") then
            if protocol == "xmpp:" and source:sub(ending, ending) == "/" then
                ending = ending + 1
                while source:sub(ending, ending):match("[A-Za-z0-9@%._%-]") do
                    ending = ending + 1
                end
            end
            local value = trimURL(source:sub(start, ending - 1))
            if start > emitted then
                local before = parser:newNode("text")
                before.literal = source:sub(emitted, start - 1)
                node:insertBefore(before)
            end
            local link = parser:newNode("link")
            link.destination, link.title =
                U.normalizeURI((protocol and "" or "mailto:") .. value), ""
            local label = parser:newNode("text")
            label.literal = value
            link:appendChild(label)
            node:insertBefore(link)
            position, emitted, changed = start + #value, start + #value, true
        else
            position = math.max(at + 1, ending)
        end
    end
    if changed then
        node.literal = source:sub(emitted)
        if node.literal == "" then
            node:unlink()
        end
    end
end

function E.emails(parser, root)
    local pending = { root }
    while #pending > 0 do
        local parent = table.remove(pending)
        local child = parent.firstChild
        while child do
            if child.type == "text" then
                local chunks = { child.literal }
                while child.next and child.next.type == "text" do
                    chunks[#chunks + 1] = child.next.literal
                    child.next:unlink()
                end
                child.literal = table.concat(chunks)
                local nextChild = child.next
                emailNodes(parser, child)
                child = nextChild
            else
                if child:isContainer() and child.type ~= "link" and child.type ~= "image" then
                    pending[#pending + 1] = child
                end
                child = child.next
            end
        end
    end
end
