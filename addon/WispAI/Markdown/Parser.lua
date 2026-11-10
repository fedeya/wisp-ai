local _, C = ...
local M, syntax = C.Markdown, C.Markdown._syntax
local allowed = { references = true, maxBytes = true, maxNodes = true, maxNesting = true }

local function configuration(source, options)
    if type(source) ~= "string" then
        return nil, { code = "invalid_source" }
    end
    if options == nil then
        options = {}
    end
    if type(options) ~= "table" then
        return nil, { code = "invalid_options" }
    end
    for key in pairs(options) do
        if not allowed[key] then
            return nil, { code = "invalid_option", option = key }
        end
    end
    if options.references ~= nil and type(options.references) ~= "boolean" then
        return nil, { code = "invalid_references" }
    end
    local result = {
        references = options.references == true,
        maxBytes = options.maxBytes == nil and 65536 or options.maxBytes,
        maxNodes = options.maxNodes == nil and 20000 or options.maxNodes,
        maxNesting = options.maxNesting == nil and 64 or options.maxNesting,
    }
    for _, name in ipairs({ "maxBytes", "maxNodes", "maxNesting" }) do
        local value = result[name]
        if
            type(value) ~= "number"
            or value < 1
            or value > 2147483647
            or value ~= math.floor(value)
        then
            return nil, { code = "invalid_limit", option = name }
        end
    end
    if #source > result.maxBytes then
        return nil, { code = "max_bytes", limit = result.maxBytes }
    end
    return result
end

local function normalize(source, checkpoint)
    local chunks, offset, start = {}, 1, 1
    while offset <= #source do
        checkpoint()
        local byte = source:byte(offset)
        local replacement, after
        if byte == 13 then
            replacement = "\n"
            after = offset + (source:byte(offset + 1) == 10 and 2 or 1)
        elseif byte == 0 then
            replacement, after = syntax.utf8(0xFFFD), offset + 1
        elseif byte >= 128 then
            local code
            code, after = syntax.codepoint(source, offset)
            if code == 0xFFFD and after == offset + 1 then
                replacement = syntax.utf8(0xFFFD)
            end
        else
            local nextSpecial = source:find("[%z\r\128-\255]", offset)
            after = nextSpecial or #source + 1
        end
        if replacement then
            chunks[#chunks + 1], chunks[#chunks + 2] = source:sub(start, offset - 1), replacement
            start = after
        end
        offset = after
    end
    chunks[#chunks + 1] = source:sub(start)
    return table.concat(chunks)
end

local nestingKinds = {
    block_quote = true,
    list = true,
    strong = true,
    emph = true,
    strikethrough = true,
    link = true,
    image = true,
}

local function build(source, options, inline, checkpoint)
    local allocated = 0
    local context = { options = options, references = {}, checkpoint = checkpoint }
    context.referenceLabel = syntax.referenceLabel
    context.unescape = function(value)
        return syntax.unescape(value, checkpoint)
    end
    context.node = function(kind, fields)
        checkpoint()
        allocated = allocated + 1
        if allocated > options.maxNodes then
            error({ markdownLimit = true, code = "max_nodes", limit = options.maxNodes }, 0)
        end
        local node = fields or {}
        node.type, node.children = kind, node.children or {}
        return node
    end
    source = normalize(source, checkpoint)
    local document
    if inline then
        document = context.node("paragraph", { children = syntax.inline(source, context) })
    else
        document = M._blocks(source, context)
        local queue = { document }
        while #queue > 0 do
            checkpoint()
            local node = table.remove(queue)
            if node._inline then
                node.children = syntax.inline(node._inline, context)
                node._inline = nil
            else
                for _, child in ipairs(node.children) do
                    queue[#queue + 1] = child
                end
            end
        end
    end
    -- Compact adjacent literal spans in one pass; never repeatedly concatenate
    -- a growing string while lexing escaped or unsupported punctuation.
    local queue = { { node = document, depth = 0 } }
    while #queue > 0 do
        checkpoint()
        local entry = table.remove(queue)
        local node, depth = entry.node, entry.depth
        if nestingKinds[node.type] then
            depth = depth + 1
        end
        if depth > options.maxNesting then
            error({ markdownLimit = true, code = "max_nesting", limit = options.maxNesting }, 0)
        end
        local children, merged, index = node.children, {}, 1
        while index <= #children do
            checkpoint()
            local child = children[index]
            if child.type == "text" then
                local chunks = { child.literal }
                while children[index + 1] and children[index + 1].type == "text" do
                    checkpoint()
                    index = index + 1
                    chunks[#chunks + 1] = children[index].literal
                end
                child.literal = table.concat(chunks)
            end
            if child.type ~= "text" or child.literal ~= "" then
                merged[#merged + 1] = child
                queue[#queue + 1] = { node = child, depth = depth }
            end
            index = index + 1
        end
        node.children = merged
    end
    return document
end

local function synchronous(source, options, inline)
    local config, err = configuration(source, options)
    if not config then
        return nil, err
    end
    local ok, result = pcall(build, source, config, inline, function() end)
    if ok then
        return result
    end
    if type(result) == "table" and result.markdownLimit then
        result.markdownLimit = nil
        return nil, result
    end
    error(result, 0)
end

function M.parse(source, options)
    return synchronous(source, options, false)
end

function M.parseInline(source, options)
    return synchronous(source, options, true)
end

-- Internal UI scheduling primitive. A task owns its options and partial tree.
-- Lua 5.1 yields stay within Lua frames; the caller's coroutine.resume catches
-- failures. Native pattern searches and allocations are not preemptible.
function M._newTask(source, options, inline)
    local config, err = configuration(source, options)
    return coroutine.create(function()
        if not config then
            return nil, err
        end
        local work = 0
        return build(source, config, inline, function()
            work = work + 1
            if work >= 64 then
                work = 0
                coroutine.yield()
            end
        end)
    end)
end
