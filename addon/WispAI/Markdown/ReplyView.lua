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
    local function prose(value, style, level, indent, runs, marker)
        if value ~= "" then
            parts[#parts + 1] = {
                type = "text",
                text = value,
                _markdown = true,
                style = style,
                level = level,
                indent = indent or 0,
                runs = runs,
                marker = marker,
            }
            for _, run in ipairs(runs or {}) do
                if run.code or run.strike then
                    parts[#parts].styled = true
                end
            end
        end
    end
    local function format(node, limit)
        return C.Markdown.InlineRenderer.render(node, message.references, message.streaming, limit)
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
                    prose("----------------", "rule", nil, entry.indent)
                else
                    local style = kind == "heading" and "heading"
                        or (kind == "code_block" and "code")
                        or (entry.quote and "quote")
                    local prefix = (entry.prefix or "") .. (entry.quote and "> " or "")
                    local formatted, runs = C.Markdown.InlineRenderer.render(
                        node,
                        message.references,
                        message.streaming,
                        nil,
                        nil,
                        true
                    )
                    prose(prefix .. formatted, style, node.level, entry.indent, runs, entry.prefix)
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
            local tree, err, loading = C.Markdown.Cache.get(part.text, false, message.streaming)
            pending = pending or loading
            if tree then
                document(tree)
            else
                errorCode = err and err.code or errorCode
                prose(C.Markdown.InlineRenderer.preview(part.text))
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
        and not parts[1].styled
        and parts[1].indent == 0
    result._markdownPending, result._markdownError = pending, errorCode
    result._markdownSources = sources
    return result
end

local function sources(message)
    local result = {}
    if message.role == "assistant" and not message._markdown then
        for _, part in ipairs(sourceParts(message)) do
            if part.type == "text" and part.text ~= "" then
                result[#result + 1] = part.text
            end
        end
    end
    return result
end

local function snapshot(message)
    local result = {}
    for index, part in ipairs(sourceParts(message)) do
        result[index] = { type = part.type, text = part.text, id = part.id }
    end
    return result
end

local function extends(previous, message)
    local current = sourceParts(message)
    if #previous > #current then
        return false
    end
    for index, before in ipairs(previous) do
        local after = current[index]
        if before.type ~= after.type or before.id ~= after.id then
            return false
        end
        if before.type == "text" then
            local text, prefix = after.text or "", before.text or ""
            if text:sub(1, #prefix) ~= prefix then
                return false
            end
        end
    end
    return true
end

local function cancelObsolete(previous, current)
    local keep = {}
    for _, source in ipairs(current) do
        keep[source] = true
    end
    for _, source in ipairs(previous or {}) do
        if not keep[source] then
            C.Markdown.Cache.cancel(source)
        end
    end
end

function view.new()
    return { revision = 0 }
end

-- The row owns one state, but only this module knows how syntax work, compiled
-- presentation and asynchronous label formatting affect its lifetime.
function view.update(state, chatId, message)
    local cache = C.Markdown.Cache
    local identityChanged = state.chatId ~= chatId
        or state.messageId ~= message.id
        or state.role ~= message.role
    local references = C.MessageFormat.signature(message.references)
    local native = C.RichSignature(message.ui)
    local dependencies = tostring(C.itemRevision) .. "\31" .. references .. "\31" .. native
    local signature = (message.role or "")
        .. "\31"
        .. (message.text or "")
        .. "\31"
        .. dependencies
        .. "\31"
        .. C.RichSignature(message.parts)
        .. "\31"
        .. tostring(message.streaming)
        .. "\31"
        .. tostring(message._markdown)
    local contentChanged = state.signature ~= signature
    local syntaxChanged = state.pending and state.syntaxRevision ~= cache.revision
    local inlineChanged = state.inlinePending and state.inlineRevision ~= cache.revision

    if identityChanged or contentChanged then
        state.inlinePending = false
    end
    if contentChanged or syntaxChanged or (identityChanged and state.pending) then
        local currentSources = sources(message)
        if state.pending then
            cancelObsolete(state.sources, currentSources)
        end
        local projected = project(message)
        local retain = projected._markdownPending
            and not identityChanged
            and state.stable
            and state.stable.dependencies == dependencies
            and extends(state.stable.parts, message)
        if projected ~= message then
            state.presentation = retain and state.stable.presentation
                or {
                    ui = projected.ui,
                    parts = projected.parts,
                    simple = projected._markdownSimple,
                }
        else
            state.presentation = nil
        end
        state.pending, state.errorCode = projected._markdownPending, projected._markdownError
        state.sources = currentSources
        state.syntaxRevision = cache.revision
        if not state.pending then
            state.stable = state.presentation
                    and {
                        presentation = state.presentation,
                        parts = snapshot(message),
                        dependencies = dependencies,
                    }
                or nil
        elseif identityChanged then
            state.stable = nil
        end
    elseif identityChanged then
        -- A complete projection can be reused across identities; a future
        -- streaming revision must belong to this reply before retaining it.
        state.stable = state.presentation
                and {
                    presentation = state.presentation,
                    parts = snapshot(message),
                    dependencies = dependencies,
                }
            or nil
    end
    if identityChanged or contentChanged or syntaxChanged or inlineChanged then
        state.revision = state.revision + 1
    end
    state.chatId, state.messageId, state.role = chatId, message.id, message.role
    state.signature = signature
    state.inlineRevision = cache.revision
    local key = state.revision .. ":" .. view.revision
    if not state.presentation then
        return message, key
    end
    -- Never retain a message object: action metadata and any future fields are
    -- always taken from the current event, even when its presentation is reused.
    local result = {}
    for name, value in pairs(message) do
        result[name] = value
    end
    result.ui, result.parts, result._markdown =
        state.presentation.ui, state.presentation.parts, true
    result._markdownSimple = state.presentation.simple
    result._markdownPending, result._markdownError = state.pending, state.errorCode
    result._markdownSources = state.sources
    return result, key
end

function view.rendered(state, pending)
    state.inlinePending = pending == true
    state.inlineRevision = C.Markdown.Cache.revision
end

view.project = project
C.Markdown.ReplyView = view
