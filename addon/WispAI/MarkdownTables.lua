local _, C = ...

-- Presentation budgets belong here, not in the Markdown grammar or wire schema.
-- Header-only and single-column tables are useful while a reply is streaming.
local MAX_COLUMNS, MAX_ROWS, MAX_TABLES, MAX_CELLS = 6, 20, 24, 600
local MAX_MARKUP = 64000
local MAX_LABEL, MAX_CELL = 100, 300

local function literal(value)
    return (value:gsub("|", "||"))
end

-- Consume semantic inline nodes once. Code is opaque; destinations and raw HTML
-- never become WoW hyperlinks or markup. Only declared Wisp references do.
local function inline(cell, references, limit)
    local output, colors, bytes = {}, {}, 0
    for node, entering in cell:walker() do
        local kind = node.type
        if entering and node.literal then
            bytes = bytes + #node.literal
            if bytes > limit then
                return nil
            end
        end
        if kind == "strong" or kind == "strikethrough" then
            if entering then
                colors[#colors + 1] = kind == "strong" and "|cffe3c77e" or "|cff99948a"
                output[#output + 1] = colors[#colors]
            else
                colors[#colors] = nil
                output[#output + 1] = "|r" .. (colors[#colors] or "")
            end
        elseif entering then
            if kind == "text" or kind == "html_inline" then
                output[#output + 1] = C.Emoji.render(literal(node.literal))
            elseif kind == "code" then
                output[#output + 1] = literal(node.literal)
            elseif kind == "reference" then
                output[#output + 1] = C.Emoji.render(
                    C.MessageFormat.reference(node.key, references)
                ) .. (colors[#colors] or "")
            elseif kind == "softbreak" or kind == "linebreak" then
                output[#output + 1] = "\n"
            end
        end
    end
    local value = table.concat(output)
    return #value <= 4096 and value or nil
end

local function tableNode(block, references, remaining, markup)
    local header = block.firstChild.firstChild
    local count, rows, columns, bytes = 0, {}, {}, 0
    local cell = header.firstChild
    while cell do
        count = count + 1
        if count > MAX_COLUMNS then
            return nil
        end
        local value = inline(cell, references, MAX_LABEL)
        if not value then
            return nil
        end
        columns[count] = { label = value, align = cell.align or "left" }
        bytes = bytes + #value
        cell = cell.next
    end
    local body = block.firstChild.next
    local row = body and body.firstChild
    while row do
        if #rows >= MAX_ROWS then
            return nil
        end
        local values = {}
        cell = row.firstChild
        while cell do
            local value = inline(cell, references, MAX_CELL)
            if not value then
                return nil
            end
            values[#values + 1] = value
            bytes = bytes + #value
            cell = cell.next
        end
        rows[#rows + 1] = values
        row = row.next
    end
    local cells = count * (#rows + 1)
    if cells > remaining or bytes > markup then
        return nil
    end
    return { kind = "table", columns = columns, rows = rows, _markdown = true }, cells, bytes
end

-- Parser source positions use normalized lines. Map them back to exact original
-- bytes so CRLF, CR, Unicode and untouched prose survive projection unchanged.
local function lineStarts(source)
    local starts, cursor = { 1 }, 1
    while true do
        local nextLine = source:find("[\r\n]", cursor)
        if not nextLine then
            break
        end
        cursor = nextLine + (source:sub(nextLine, nextLine + 1) == "\r\n" and 2 or 1)
        starts[#starts + 1] = cursor
    end
    return starts
end

local function sourceParts(message)
    if message.parts and #message.parts > 0 then
        return message.parts
    end
    local parts = { { type = "text", text = message.text or "" } }
    for _, node in ipairs(message.ui or {}) do
        if not node.parent then
            parts[#parts + 1] = { type = "ui", id = node.id }
        end
    end
    return parts
end

local function project(message)
    if message.role ~= "assistant" then
        return message
    end
    local ui, parts, ids = {}, {}, {}
    for _, node in ipairs(message.ui or {}) do
        ui[#ui + 1], ids[node.id] = node, true
    end
    local serial, added, remaining, markup = 0, 0, MAX_CELLS, MAX_MARKUP
    for _, part in ipairs(sourceParts(message)) do
        if part.type ~= "text" or not part.text:find("|", 1, true) then
            parts[#parts + 1] = part
        else
            local document, err = C.Markdown.parse(part.text, { references = true })
            if not document then
                -- A budget failure leaves the entire original message available.
                return message, err
            end
            local starts, cursor = lineStarts(part.text), 1
            local block = document.firstChild
            while block do
                if block.type == "table" then
                    repeat
                        serial = serial + 1
                    until not ids["markdown_table_" .. serial]
                    local node, cells, bytes
                    if added < MAX_TABLES then
                        node, cells, bytes = tableNode(block, message.references, remaining, markup)
                    end
                    if node then
                        local first = starts[block.sourcepos[1][1]]
                        local after = starts[block.sourcepos[2][1] + 1] or (#part.text + 1)
                        if first > cursor then
                            parts[#parts + 1] = {
                                type = "text",
                                text = part.text:sub(cursor, first - 1),
                            }
                        end
                        node.id = "markdown_table_" .. serial
                        ui[#ui + 1], ids[node.id] = node, true
                        parts[#parts + 1] = { type = "ui", id = node.id }
                        cursor, added, remaining = after, added + 1, remaining - cells
                        markup = markup - bytes
                    end
                end
                block = block.next
            end
            if cursor <= #part.text then
                parts[#parts + 1] = { type = "text", text = part.text:sub(cursor) }
            end
        end
    end
    if added == 0 then
        return message
    end
    local view = {}
    for key, value in pairs(message) do
        view[key] = value
    end
    view.ui, view.parts = ui, parts
    return view
end

C.MarkdownTables = { project = project }
