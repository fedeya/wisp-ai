local H = {}

function H.parser()
    local C = {}
    for _, file in ipairs({
        "Node",
        "Data",
        "Scanner",
        "Inline",
        "Extensions",
        "Block",
        "Parser",
        "Stream",
    }) do
        assert(loadfile("addon/WispAI/Markdown/" .. file .. ".lua"))("WispAI", C)
    end
    return C.Markdown
end

local function escape(value)
    return (value:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

-- GFM's published HTML and cmark-gfm use different valid attribute orders and
-- void-element spellings for task checkboxes. Compare those semantically.
function H.canonicalHTML(value)
    return (
        value:gsub("<input([^>]*)>", function(attributes)
            if not attributes:find('type="checkbox"', 1, true) then
                return "<input" .. attributes .. ">"
            end
            local keys = {}
            for name, setting in attributes:gmatch('([%w_%-]+)="([^"]*)"') do
                keys[#keys + 1] = name .. '="' .. setting .. '"'
            end
            table.sort(keys)
            return "<input " .. table.concat(keys, " ") .. ">"
        end)
    )
end

-- This writer is a test oracle adapter, not the addon's presentation layer.
-- Official Markdown examples specify HTML, so it exposes parser semantics to
-- that corpus without depending on FontStrings or any WoW globals.
function H.html(document)
    local output, imageDepth = {}, 0
    local function emit(value)
        output[#output + 1] = value
    end
    local function newline()
        if #output > 0 and output[#output]:sub(-1) ~= "\n" then
            emit("\n")
        end
    end
    local function checkbox(node)
        if node.parent and node.parent.type == "item" and node.parent.task then
            emit(
                '<input type="checkbox"'
                    .. (node.parent.checked and ' checked=""' or "")
                    .. ' disabled="" /> '
            )
        end
    end
    local forbidden = {
        title = true,
        textarea = true,
        style = true,
        xmp = true,
        iframe = true,
        noembed = true,
        noframes = true,
        script = true,
        plaintext = true,
    }
    local function raw(value)
        if document.dialect ~= "gfm" then
            return value
        end
        return (
            value:gsub("<(/?)([%a][%w]*)([ \t\r\n/>])", function(slash, tag, following)
                return (forbidden[tag:lower()] and "&lt;" or "<") .. slash .. tag .. following
            end)
        )
    end
    for node, entering in document:walker() do
        local kind = node.type
        if kind == "text" or kind == "code" or kind == "reference" then
            if entering then
                if kind == "code" and imageDepth == 0 then
                    emit("<code>")
                end
                emit(escape(node.literal or ""))
                if kind == "code" and imageDepth == 0 then
                    emit("</code>")
                end
            end
        elseif kind == "softbreak" then
            emit("\n")
        elseif kind == "linebreak" then
            emit(imageDepth == 0 and "<br />\n" or "\n")
        elseif kind == "image" then
            if entering then
                if imageDepth == 0 then
                    emit('<img src="' .. escape(node.destination) .. '" alt="')
                end
                imageDepth = imageDepth + 1
            else
                imageDepth = imageDepth - 1
                if imageDepth == 0 then
                    emit(
                        '"'
                            .. (node.title ~= "" and ' title="' .. escape(node.title) .. '"' or "")
                            .. " />"
                    )
                end
            end
        elseif imageDepth == 0 then
            if kind == "paragraph" then
                local tight = node.parent
                    and node.parent.type == "item"
                    and node.parent.parent.listTight
                if entering then
                    if not tight then
                        newline()
                        emit("<p>")
                    end
                    if node.parent and node == node.parent.firstChild then
                        checkbox(node)
                    end
                elseif not tight then
                    emit("</p>")
                    newline()
                end
            elseif kind == "heading" then
                if entering then
                    newline()
                    emit("<h" .. node.level .. ">")
                else
                    emit("</h" .. node.level .. ">")
                    newline()
                end
            elseif kind == "emph" or kind == "strong" or kind == "strikethrough" then
                local tag = kind == "emph" and "em" or kind == "strikethrough" and "del" or "strong"
                emit("<" .. (entering and "" or "/") .. tag .. ">")
            elseif kind == "link" then
                if entering then
                    emit(
                        '<a href="'
                            .. escape(node.destination)
                            .. '"'
                            .. (node.title ~= "" and ' title="' .. escape(node.title) .. '"' or "")
                            .. ">"
                    )
                else
                    emit("</a>")
                end
            elseif kind == "code_block" then
                newline()
                local language = node.info and node.info:match("^(%S+)")
                emit(
                    "<pre><code"
                        .. (language and ' class="language-' .. escape(language) .. '"' or "")
                        .. ">"
                        .. escape(node.literal)
                        .. "</code></pre>"
                )
                newline()
            elseif kind == "html_inline" then
                emit(raw(node.literal))
            elseif kind == "html_block" then
                newline()
                emit(raw(node.literal))
                emit("\n")
            elseif kind == "thematic_break" then
                newline()
                emit("<hr />")
                newline()
            elseif kind == "block_quote" then
                newline()
                emit(entering and "<blockquote>" or "</blockquote>")
                newline()
            elseif kind == "list" then
                local tag = node.listType == "ordered" and "ol" or "ul"
                newline()
                emit(
                    "<"
                        .. (entering and "" or "/")
                        .. tag
                        .. (entering and node.listStart and node.listStart ~= 1 and ' start="' .. node.listStart .. '"' or "")
                        .. ">"
                )
                newline()
            elseif kind == "item" then
                if entering then
                    newline()
                    emit("<li>")
                else
                    emit("</li>")
                    newline()
                end
            elseif
                kind == "table"
                or kind == "table_head"
                or kind == "table_body"
                or kind == "table_row"
            then
                local tag = ({
                    table = "table",
                    table_head = "thead",
                    table_body = "tbody",
                    table_row = "tr",
                })[kind]
                newline()
                emit("<" .. (entering and "" or "/") .. tag .. ">")
                newline()
            elseif kind == "table_cell" then
                local tag = node.header and "th" or "td"
                if entering then
                    newline()
                    emit(
                        "<" .. tag .. (node.align and ' align="' .. node.align .. '"' or "") .. ">"
                    )
                else
                    emit("</" .. tag .. ">")
                    newline()
                end
            end
        end
    end
    return table.concat(output)
end

return H
