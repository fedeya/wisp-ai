local _, C = ...
local templates = setmetatable({}, { __mode = "k" })

local function escaped(value)
    return (tostring(value or ""):gsub("|", "||"))
end

local function prefix(value, bytes)
    if #value <= bytes then
        return value, false
    end
    local after = bytes + 1
    while
        after > 1
        and value:byte(after)
        and value:byte(after) >= 128
        and value:byte(after) < 192
    do
        after = after - 1
    end
    return value:sub(1, after - 1), true
end

-- A template contains static WoW text plus reference keys. Reformatting item
-- data reuses both syntax and static text; no Markdown substitutions are used.
local function compile(root, limit, fromUser)
    local cached = templates[root]
    if cached and cached.limit == limit and cached.fromUser == fromUser then
        return cached.parts
    end
    local parts, colors, stack, remaining = {}, {}, { { node = root } }, limit
    local clipped = false
    while #stack > 0 do
        local entry = table.remove(stack)
        local node, kind = entry.node, entry.node.type
        local color = kind == "strong" and "|cffe3c77e"
            or (kind == "strikethrough" and "|cff99948a")
            or (kind == "emph" and "|cffded6be")
        if entry.close then
            colors[#colors] = nil
            parts[#parts + 1] = "|r" .. (colors[#colors] or "")
        elseif kind == "reference" then
            remaining = remaining - #(node.literal or node.key)
            if remaining < 0 then
                clipped = true
                break
            end
            parts[#parts + 1] = { key = node.key, restore = colors[#colors] or "" }
        elseif kind == "reference_pending" then
            parts[#parts + 1] = { pending = true, literal = node.literal }
        elseif kind == "native_link" then
            parts[#parts + 1] = fromUser
                    and (C.Emoji.render(node.literal) .. (colors[#colors] or ""))
                or escaped(node.literal)
        elseif node.literal ~= nil then
            local value, cut = prefix(node.literal, remaining)
            remaining = remaining - #value
            local plain = escaped(value)
            local text = (kind == "code" or kind == "code_block") and plain or C.Emoji.render(plain)
            -- Repeated emoji textures can expand a short source substantially.
            parts[#parts + 1] = #text <= math.max(4096, limit * 2) and text or plain
            if cut then
                clipped = true
                break
            end
        elseif kind == "softbreak" or kind == "linebreak" then
            parts[#parts + 1] = "\n"
        else
            if color then
                colors[#colors + 1] = color
                parts[#parts + 1] = color
                stack[#stack + 1] = { node = node, close = true }
            end
            for index = #(node.children or {}), 1, -1 do
                stack[#stack + 1] = { node = node.children[index] }
            end
        end
    end
    if clipped then
        parts[#parts + 1] = "..."
        if #colors > 0 then
            parts[#parts + 1] = "|r"
        end
    end
    templates[root] = { limit = limit, parts = parts, fromUser = fromUser }
    return parts
end

local function render(node, references, streaming, limit, fromUser)
    fromUser = fromUser == true
    local result, bytes, maximum = {}, 0, math.max(4096, (limit or 65536) * 2)
    for _, part in ipairs(compile(node, limit or 65536, fromUser)) do
        local value
        if type(part) == "string" then
            value = part
        elseif part.pending then
            value = streaming and "..." or escaped(part.literal)
        else
            local ref = references and references[part.key]
            value = not ref and streaming and "..."
                or C.Emoji.render(C.MessageFormat.reference(part.key, references))
            if #value > 4096 then
                value = escaped(prefix(tostring(ref and ref.label or "Reference"), 300))
            end
            value = value .. part.restore
        end
        if bytes + #value > maximum then
            result[#result + 1] = "...|r"
            break
        end
        result[#result + 1], bytes = value, bytes + #value
    end
    return table.concat(result)
end

local function formatted(value, references, fromUser, streaming)
    value = tostring(value or "")
    if not value:find("[%*_%~`%[%]\\<|&\n\r]") then
        return C.Emoji.render(escaped(value))
    end
    local tree, _, pending = C.MarkdownCache.get(value, true, streaming)
    C.MarkdownText.pending = C.MarkdownText.pending or pending
    return tree and render(tree, references, streaming, nil, fromUser)
        or C.MarkdownText.preview(value)
end

local function preview(value)
    local text, clipped = prefix(value, 8000)
    return C.Emoji.render(escaped(text)) .. (clipped and "\n..." or "")
end

C.MarkdownText = { render = render, literal = escaped, preview = preview }
C.FormatText = formatted
