local _, C = ...
local M = C.Markdown
local U = M.Scanner
local internalFields = {
    "_open",
    "_depth",
    "_lines",
    "_lineSource",
    "_content",
    "_list",
    "_fenced",
    "_fenceLength",
    "_fenceChar",
    "_fenceOffset",
    "_htmlType",
}

local function optionsFor(options)
    if options == nil then
        options = {}
    end
    if type(options) ~= "table" then
        return nil, { code = "invalid_options" }
    end
    local config = {
        gfm = options.dialect ~= "commonmark",
        dialect = options.dialect or "gfm",
        references = options.references == true,
        maxBytes = options.maxBytes == nil and 1024 * 1024 or options.maxBytes,
        maxNodes = options.maxNodes == nil and 100000 or options.maxNodes,
        maxNesting = options.maxNesting == nil and 256 or options.maxNesting,
    }
    if options.dialect ~= nil and options.dialect ~= "commonmark" and options.dialect ~= "gfm" then
        return nil, { code = "invalid_dialect" }
    end
    if options.references ~= nil and type(options.references) ~= "boolean" then
        return nil, { code = "invalid_references" }
    end
    for _, key in ipairs({ "maxBytes", "maxNodes", "maxNesting" }) do
        local value = config[key]
        if
            type(value) ~= "number"
            or value ~= math.floor(value)
            or value < 1
            or value > 2147483647
        then
            return nil, { code = "invalid_limit", option = key }
        end
    end
    return config
end

local function normalize(source)
    source = source:gsub("\r\n", "\n"):gsub("\r", "\n"):gsub("%z", U.replacement)
    local output, pos, start = {}, 1, 1
    while true do
        pos = source:find("[\128-\255]", pos)
        if not pos then
            break
        end
        local code, nextPos = U.codepoint(source, pos)
        if code == 0xFFFD and nextPos == pos + 1 then
            output[#output + 1], output[#output + 2] = source:sub(start, pos - 1), U.replacement
            start = nextPos
        end
        pos = nextPos
    end
    if #output == 0 then
        return source
    end
    output[#output + 1] = source:sub(start)
    return table.concat(output)
end

local function parse(source, options, inline)
    if type(source) ~= "string" then
        return nil, { code = "invalid_source" }
    end
    local config, err = optionsFor(options)
    if not config then
        return nil, err
    end
    if #source > config.maxBytes then
        return nil, { code = "max_bytes", limit = config.maxBytes }
    end
    source = normalize(source)
    local count = 0
    local function newNode(_, kind, sourcepos)
        count = count + 1
        if count > config.maxNodes then
            error({ markdownLimit = true, code = "max_nodes", limit = config.maxNodes }, 0)
        end
        return M.Node.new(kind, sourcepos)
    end
    local ok, result = pcall(function()
        if inline then
            local node = newNode(nil, "paragraph", { { 1, 1 }, { 1, #source } })
            node._content = source
            M.Inline.new(config, newNode):parse(node, false)
            return node
        end
        return M.Block.new(config, newNode):parse(source)
    end)
    if not ok then
        if type(result) == "table" and result.markdownLimit then
            result.markdownLimit = nil
            return nil, result
        end
        error(result, 0)
    end
    result.dialect = config.gfm and "gfm" or "commonmark"
    for node, entering in result:walker() do
        if entering then
            for _, field in ipairs(internalFields) do
                node[field] = nil
            end
        end
    end
    return result
end

function M.parse(source, options)
    return parse(source, options, false)
end

function M.parseInline(source, options)
    return parse(source, options, true)
end

M._options = optionsFor
