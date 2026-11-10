local _, C = ...
local MAX_BLOCKS, MAX_TABLES, MAX_ROWS, MAX_COLUMNS = 256, 24, 200, 6
local MAX_TABLE_BYTES = 64000
local view = { revision = 0 }

function view.invalidate()
    view.revision = view.revision + 1
    if C.Refresh then
        C.Refresh()
    end
    if C.RefreshInline then
        C.RefreshInline()
    end
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
    if message.role ~= "assistant" or message._markdown then
        return message
    end
    local ui, parts, ids = {}, {}, {}
    local pending, errorCode, serial, blocks, tables = false, nil, 0, 0, 0
    local remainingBytes = MAX_TABLE_BYTES
    local sources = {}
    for _, node in ipairs(message.ui or {}) do
        ui[#ui + 1], ids[node.id] = node, true
    end
    local function prose(value, style, level, indent)
        if value ~= "" then
            parts[#parts + 1] = {
                type = "text",
                text = value,
                _markdown = true,
                style = style,
                level = level,
                indent = indent or 0,
            }
        end
    end
    local function format(node, limit)
        return C.MarkdownText.render(node, message.references, message.streaming, limit)
    end
    local function tableView(node, indent)
        tables = tables + 1
        if tables > MAX_TABLES or remainingBytes < 4096 then
            prose("Additional tables are omitted from this view.", "quote", nil, indent)
            return
        end
        local rows = node.children or {}
        local first = rows[1]
        if not first then
            return
        end
        local columns, formatted, bytes, count = {}, {}, 0, #(first.children or {})
        for index = 1, math.min(MAX_COLUMNS, count) do
            local label = format(first.children[index], 100)
            columns[index] = { label = label, align = (node.align or {})[index] or "left" }
            bytes = bytes + #label
        end
        for index = 2, math.min(#rows, MAX_ROWS + 1) do
            local cells, rowBytes = {}, 0
            for column = 1, #columns do
                local cell = (rows[index].children or {})[column]
                cells[column] = cell and format(cell, 300) or ""
                rowBytes = rowBytes + #cells[column]
            end
            if bytes + rowBytes > remainingBytes then
                break
            end
            formatted[#formatted + 1] = cells
            bytes = bytes + rowBytes
        end
        repeat
            serial = serial + 1
        until not ids["markdown_table_" .. serial]
        local initial = {}
        for index = 1, math.min(20, #formatted) do
            initial[index] = formatted[index]
        end
        local notices = {}
        if count > #columns then
            notices[#notices + 1] = "Showing the first "
                .. #columns
                .. " of "
                .. count
                .. " columns."
        end
        if #rows - 1 > #formatted then
            notices[#notices + 1] = "Showing the first "
                .. #formatted
                .. " of "
                .. (#rows - 1)
                .. " rows."
        end
        local native = {
            id = "markdown_table_" .. serial,
            kind = "table",
            _markdown = true,
            columns = columns,
            rows = initial,
            _markdownRows = formatted,
            totalRows = #rows - 1,
            totalColumns = count,
            notice = #notices > 0 and table.concat(notices, " ") or nil,
        }
        ui[#ui + 1], ids[native.id] = native, true
        remainingBytes = math.max(0, remainingBytes - bytes)
        parts[#parts + 1] = { type = "ui", id = native.id, indent = indent }
    end
    local function document(tree)
        local stack = { { node = tree, indent = 0 } }
        while #stack > 0 and blocks < MAX_BLOCKS do
            local entry = table.remove(stack)
            local node, kind, children = entry.node, entry.node.type, entry.node.children or {}
            if kind == "document" or kind == "block_quote" or kind == "item" then
                local indent = entry.indent + (kind == "block_quote" and 12 or 0)
                for index = #children, 1, -1 do
                    stack[#stack + 1] = {
                        node = children[index],
                        indent = indent,
                        prefix = index == 1 and entry.prefix or nil,
                        quote = kind == "block_quote" or entry.quote,
                    }
                end
            elseif kind == "list" then
                for index = #children, 1, -1 do
                    local item = children[index]
                    local prefix = node.ordered and ((node.start or 1) + index - 1) .. ". " or "- "
                    if item.checked ~= nil then
                        prefix = item.checked and "[x] " or "[ ] "
                    end
                    stack[#stack + 1] = {
                        node = item,
                        indent = entry.indent + 12,
                        prefix = prefix,
                        quote = entry.quote,
                    }
                end
            else
                blocks = blocks + 1
                if kind == "table" then
                    tableView(node, entry.indent)
                elseif kind == "thematic_break" then
                    prose("----------------", "quote", nil, entry.indent)
                else
                    local style = kind == "heading" and "heading"
                        or (kind == "code_block" and "code")
                        or (entry.quote and "quote")
                    local prefix = (entry.prefix or "") .. (entry.quote and "> " or "")
                    prose(prefix .. format(node), style, node.level, entry.indent)
                end
            end
        end
        if #stack > 0 then
            prose("Further content is available in the original response.", "quote")
        end
    end
    for _, part in ipairs(sourceParts(message)) do
        if part.type == "ui" then
            parts[#parts + 1] = part
        elseif part.type == "text" and part.text ~= "" then
            sources[#sources + 1] = part.text
            local tree, err, loading = C.MarkdownCache.get(part.text, false, message.streaming)
            pending = pending or loading
            if tree then
                document(tree)
            else
                errorCode = err and err.code or errorCode
                prose(C.MarkdownText.preview(part.text))
            end
        end
    end
    local result = {}
    for key, value in pairs(message) do
        result[key] = value
    end
    result.ui, result.parts, result._markdown = ui, parts, true
    result._markdownSimple = #ui == 0
        and #parts == 1
        and parts[1].type == "text"
        and not parts[1].style
        and parts[1].indent == 0
    result._markdownPending, result._markdownError = pending, errorCode
    result._markdownSources = sources
    return result
end

view.project = project
C.MarkdownView = view
