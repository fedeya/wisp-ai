local _, ns = ...
local sharedText = ns.Shared.Text
local templates = setmetatable({}, { __mode = "k" })

local function escaped(value)
    return (tostring(value or ""):gsub("|", "||"))
end

-- Macro coloring stays inside literal code: no Markdown or game links are parsed.
-- Keep one text run so long macros do not allocate a widget per token.
local function macroCode(value, info)
    local language = (info or ""):match("^%s*(%S+)") or ""
    if
        not ({ [""] = true, macro = true, wowmacro = true, lua = true, text = true })[language:lower()]
    then
        return escaped(value)
    end
    local lines, commands = {}, 0
    for line in (value .. "\n"):gmatch("(.-)\n") do
        local indent, command, tail = line:match("^(%s*)([/#][%a]+)(.*)$")
        if
            command
            and (command:sub(1, 1) == "/" or command == "#showtooltip" or command == "#show")
        then
            commands = commands + 1
            local color = command:sub(1, 1) == "/" and "|cff8fb7c6" or "|cffb0aa8e"
            -- Stop at the next opener so unmatched '[' cannot rescan overlapping suffixes.
            tail = escaped(tail):gsub("(%[[^%[%]\n]*%])", function(condition)
                -- Each word closes its color so wrapping into another font string is safe.
                return (condition:gsub("%S+", "|cffaca0c2%0|r"))
            end)
            lines[#lines + 1] = indent .. color .. command .. "|r" .. tail
        elseif line:match("%S") then
            return escaped(value)
        else
            lines[#lines + 1] = line
        end
    end
    return commands > 0 and table.concat(lines, "\n") or escaped(value)
end

-- A template contains static WoW text plus reference keys. Reformatting item
-- data reuses both syntax and static text; no Markdown substitutions are used.
local function compile(root, limit, fromUser)
    local cached = templates[root]
    if cached and cached.limit == limit and cached.fromUser == fromUser then
        return cached.parts
    end
    local parts, colors, stack, remaining =
        { styles = {}, links = {} }, {}, { { node = root } }, limit
    local clipped, openLinks = false, 0
    local function append(value, entry, kind)
        parts[#parts + 1] = value
        parts.styles[#parts] = {
            color = colors[#colors],
            code = kind == "code" or kind == "code_block",
            strike = entry.strike,
            url = entry.url,
            atomic = kind == "reference" or kind == "reference_pending" or kind == "native_link",
        }
    end
    while #stack > 0 do
        local entry = table.remove(stack)
        local node, kind = entry.node, entry.node.type
        local color = kind == "strong" and "|cffe3c77e"
            or (kind == "strikethrough" and "|cff99948a")
            or (kind == "emph" and "|cffded6be")
        if entry.close then
            if entry.link then
                parts[#parts + 1] = "|h"
                parts.links[#parts], openLinks = -1, openLinks - 1
            end
            colors[#colors] = nil
            parts[#parts + 1] = "|r" .. (colors[#colors] or "")
        elseif kind == "reference" then
            remaining = remaining - #(node.literal or node.key)
            if remaining < 0 then
                clipped = true
                break
            end
            append({ key = node.key, restore = colors[#colors] or "" }, entry, kind)
        elseif kind == "reference_pending" then
            append({ pending = true, literal = node.literal }, entry, kind)
        elseif kind == "native_link" then
            append(
                fromUser and (ns.UI.Emoji.Render(node.literal) .. (colors[#colors] or ""))
                    or escaped(node.literal),
                entry,
                kind
            )
        elseif node.literal ~= nil then
            local value, cut = sharedText.TruncateUtf8Bytes(node.literal, remaining)
            remaining = remaining - #value
            local plain = escaped(value)
            local text = kind == "code_block" and macroCode(value, node.info)
                or kind == "code" and plain
                or ns.UI.Emoji.Render(plain)
            -- Repeated emoji textures can expand a short source substantially.
            append(#text <= math.max(4096, limit * 2) and text or plain, entry, kind)
            if cut then
                clipped = true
                break
            end
        elseif kind == "softbreak" or kind == "linebreak" then
            append("\n", entry, kind)
        else
            local url = kind == "link" and ns.Markdown.Links.Valid(node.destination) or entry.url
            local link = kind == "link" and url ~= nil
            if link then
                color = "|cff80c8ef"
            end
            if color then
                colors[#colors + 1] = color
                parts[#parts + 1] = link
                        and (color .. "|H" .. ns.Markdown.Links.Encode(url) .. "|h")
                    or color
                if link then
                    parts.links[#parts], openLinks = 1, openLinks + 1
                end
                stack[#stack + 1] = { node = node, close = true, link = link }
            end
            for index = #(node.children or {}), 1, -1 do
                stack[#stack + 1] = {
                    node = node.children[index],
                    strike = kind == "strikethrough" or entry.strike,
                    url = url,
                }
            end
        end
    end
    if clipped then
        append("...", {}, "text")
        for _ = 1, openLinks do
            parts[#parts + 1] = "|h"
            parts.links[#parts] = -1
        end
        if #colors > 0 then
            parts[#parts + 1] = "|r"
        end
    end
    templates[root] = { limit = limit, parts = parts, fromUser = fromUser }
    return parts
end

local function render(node, references, streaming, limit, fromUser, wantRuns)
    fromUser = fromUser == true
    local result, bytes, maximum = {}, 0, math.max(4096, (limit or 65536) * 2)
    local template, runs = compile(node, limit or 65536, fromUser), wantRuns and {} or nil
    local openLinks = 0
    for index, part in ipairs(template) do
        local value
        if type(part) == "string" then
            value = part
        elseif part.pending then
            value = streaming and "..." or escaped(part.literal)
        else
            local ref = references and references[part.key]
            value = not ref and streaming and "..."
                or ns.UI.Emoji.Render(ns.UI.MessageFormat.Reference(part.key, references))
            if #value > 4096 then
                value = escaped(
                    sharedText.TruncateUtf8Bytes(tostring(ref and ref.label or "Reference"), 300)
                )
            end
            value = value .. part.restore
        end
        if bytes + #value > maximum then
            result[#result + 1] = string.rep("|h", openLinks) .. "...|r"
            if runs then
                runs[#runs + 1] = { text = "..." }
            end
            break
        end
        result[#result + 1], bytes = value, bytes + #value
        openLinks = openLinks + (template.links[index] or 0)
        local style = template.styles[index]
        if runs and style then
            local run = {
                text = value,
                color = style.color,
                code = style.code,
                strike = style.strike,
                atomic = style.atomic or style.url ~= nil,
            }
            if style.url then
                run.text = "|cff80c8ef|H"
                    .. ns.Markdown.Links.Encode(style.url)
                    .. "|h"
                    .. value
                    .. "|h|r"
            end
            runs[#runs + 1] = run
        end
    end
    return table.concat(result), runs
end

local function formatted(value, references, fromUser, streaming)
    value = tostring(value or "")
    if not value:find("[%*_%~`%[%]\\<|&\n\r]") then
        return ns.UI.Emoji.Render(escaped(value)), false
    end
    local tree, _, pending = ns.Markdown.Cache.Get(value, true, streaming)
    return tree and render(tree, references, streaming, nil, fromUser)
        or ns.Markdown.InlineRenderer.Preview(value),
        pending == true
end

local function preview(value)
    local text, clipped = sharedText.TruncateUtf8Bytes(value, 8000)
    return ns.UI.Emoji.Render(escaped(text)) .. (clipped and "\n..." or "")
end

ns.Markdown.InlineRenderer = { Render = render, Literal = escaped, Preview = preview }
ns.UI.FormatText = formatted
