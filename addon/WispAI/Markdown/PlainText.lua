local _, ns = ...

-- Readable plain text for a reply, as a player would paste it elsewhere. It walks
-- the parser's tree; syntax stays with the parser. Runs only on demand (a copy),
-- never during layout.
local plain = {}

--- Removes the client's escape sequences (colors, hyperlinks, textures) and keeps
--- their visible text. An escaped bar (`||`) becomes a single `|`.
function plain.StripEscapes(text)
    text = tostring(text or ""):gsub("||", "\1")
    text = text:gsub("|c%x%x%x%x%x%x%x%x", "")
        :gsub("|r", "")
        :gsub("|H.-|h(.-)|h", "%1")
        :gsub("|T.-|t", "")
        :gsub("|A.-|a", "")
        :gsub("|n", "\n")
        :gsub("\1", "|")
    return text
end

local BRACKETED = { item = true, spell = true, quest = true }

local function referenceText(key, references)
    local ref = references and references[key]
    if type(ref) ~= "table" then
        return "(reference unavailable)"
    end
    local name = plain.StripEscapes(tostring(ref.label or "Reference")):gsub("[%c%[%]]", "")
    return BRACKETED[ref.kind] and ("[" .. name .. "]") or name
end

local function inlineText(node, references, out)
    for _, child in ipairs(node.children or {}) do
        local kind = child.type
        if kind == "reference" then
            out[#out + 1] = referenceText(child.key, references)
        elseif kind == "native_link" then
            out[#out + 1] = plain.StripEscapes(child.literal)
        elseif kind == "softbreak" or kind == "linebreak" then
            out[#out + 1] = "\n"
        elseif kind == "link" then
            local first = #out + 1
            inlineText(child, references, out)
            local label = table.concat(out, "", first)
            local url = child.destination
            if type(url) == "string" and url ~= "" and url ~= label then
                out[#out + 1] = " (" .. url .. ")"
            end
        elseif child.literal ~= nil then
            out[#out + 1] = child.literal
        else
            inlineText(child, references, out)
        end
    end
    return out
end

local function prefixLines(text, first, rest)
    local lines, index = {}, 0
    for line in (text .. "\n"):gmatch("(.-)\n") do
        index = index + 1
        local prefix = index == 1 and first or rest
        lines[index] = line == "" and prefix:gsub("%s+$", "") or (prefix .. line)
    end
    return table.concat(lines, "\n")
end

local blockText

local function blocksText(children, references, separator)
    local texts = {}
    for _, child in ipairs(children or {}) do
        local text = blockText(child, references)
        if text ~= "" then
            texts[#texts + 1] = text
        end
    end
    return table.concat(texts, separator)
end

local function cellText(cell, references)
    return (table.concat(inlineText(cell, references, {})):gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Tables read as one line per row: "Header: value, Header: value".
local function tableText(node, references)
    local headers, lines = {}, {}
    for _, row in ipairs(node.children or {}) do
        if row.header then
            for index, cell in ipairs(row.children or {}) do
                headers[index] = cellText(cell, references)
            end
        else
            local fields = {}
            for index, cell in ipairs(row.children or {}) do
                local value = cellText(cell, references)
                if value ~= "" then
                    local header = headers[index]
                    fields[#fields + 1] = (header and header ~= "") and (header .. ": " .. value)
                        or value
                end
            end
            if #fields > 0 then
                lines[#lines + 1] = table.concat(fields, ", ")
            end
        end
    end
    if #lines == 0 then
        return table.concat(headers, ", ")
    end
    return table.concat(lines, "\n")
end

blockText = function(node, references)
    local kind = node.type
    if kind == "paragraph" or kind == "heading" then
        return table.concat(inlineText(node, references, {}))
    elseif kind == "code_block" then
        return (tostring(node.literal or ""):gsub("\n+$", ""))
    elseif kind == "thematic_break" then
        return ""
    elseif kind == "list" then
        local separator = node.tight == false and "\n\n" or "\n"
        local items = {}
        for index, item in ipairs(node.children or {}) do
            local marker = node.ordered and (((node.start or 1) + index - 1) .. ". ") or "- "
            local indent = string.rep(" ", #marker)
            if item.task then
                marker = marker .. (item.checked and "[x] " or "[ ] ")
            end
            local body = blocksText(item.children, references, separator)
            items[#items + 1] = prefixLines(body, marker, indent)
        end
        return table.concat(items, separator)
    elseif kind == "block_quote" then
        return prefixLines(blocksText(node.children, references, "\n\n"), "> ", "> ")
    elseif kind == "table" then
        return tableText(node, references)
    end
    return blocksText(node.children, references, "\n\n")
end

--- Plain text for one Markdown source. Falls back to the source without escape
--- codes when it exceeds the parser's limits.
function plain.FromSource(source, references)
    source = tostring(source or "")
    local document = ns.Markdown.Parse(source, { references = true })
    if not document then
        return plain.StripEscapes(source)
    end
    return blockText(document, references)
end

--- Plain text for a reply message: its text parts in order, without generated UI.
function plain.FromMessage(message)
    local sources = {}
    if type(message.parts) == "table" and #message.parts > 0 then
        for _, part in ipairs(message.parts) do
            if part.type == "text" and type(part.text) == "string" then
                sources[#sources + 1] = part.text
            end
        end
    else
        sources[1] = message.text
    end
    local texts = {}
    for _, source in ipairs(sources) do
        local text = plain.FromSource(source, message.references)
        text = text:gsub("^%s+", ""):gsub("%s+$", "")
        if text ~= "" then
            texts[#texts + 1] = text
        end
    end
    return table.concat(texts, "\n\n")
end

ns.Markdown.PlainText = plain
