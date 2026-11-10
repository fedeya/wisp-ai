local helper = {}
function helper.parser()
    local C = {}
    for _, name in ipairs({ "Syntax", "Block", "Parser" }) do
        assert(loadfile("addon/WispAI/Markdown/" .. name .. ".lua"))("WispAI", C)
    end
    return C.Markdown
end
function helper.text(node)
    if node.literal then
        return node.literal
    end
    if node.type == "softbreak" or node.type == "linebreak" then
        return "\n"
    end
    local out = {}
    for _, child in ipairs(node.children) do
        out[#out + 1] = helper.text(child)
    end
    return table.concat(out)
end
return helper
