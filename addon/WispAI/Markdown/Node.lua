local _, C = ...
local M = {}
C.Markdown = M

-- Linked nodes keep delimiter resolution and tree edits independent of document size.
-- The public walker is iterative, including for deeply nested inline markup.
local Node = {}
Node.__index = Node
local containers = {
    document = true,
    block_quote = true,
    list = true,
    item = true,
    paragraph = true,
    heading = true,
    emph = true,
    strong = true,
    link = true,
    image = true,
    strikethrough = true,
    table = true,
    table_head = true,
    table_body = true,
    table_row = true,
    table_cell = true,
}

function Node.new(kind, sourcepos)
    return setmetatable({ type = kind, sourcepos = sourcepos, _open = true }, Node)
end

function Node:unlink()
    if self.prev then
        self.prev.next = self.next
    elseif self.parent then
        self.parent.firstChild = self.next
    end
    if self.next then
        self.next.prev = self.prev
    elseif self.parent then
        self.parent.lastChild = self.prev
    end
    self.parent, self.next, self.prev = nil, nil, nil
    return self
end

function Node:appendChild(child)
    child:unlink()
    child.parent, child.prev = self, self.lastChild
    if self.lastChild then
        self.lastChild.next = child
    else
        self.firstChild = child
    end
    self.lastChild = child
    return child
end

function Node:prependChild(child)
    child:unlink()
    child.parent, child.next = self, self.firstChild
    if self.firstChild then
        self.firstChild.prev = child
    else
        self.lastChild = child
    end
    self.firstChild = child
    return child
end

function Node:insertAfter(sibling)
    sibling:unlink()
    sibling.next, sibling.prev, sibling.parent = self.next, self, self.parent
    if sibling.next then
        sibling.next.prev = sibling
    elseif sibling.parent then
        sibling.parent.lastChild = sibling
    end
    self.next = sibling
    return sibling
end

function Node:insertBefore(sibling)
    sibling:unlink()
    sibling.prev, sibling.next, sibling.parent = self.prev, self, self.parent
    if sibling.prev then
        sibling.prev.next = sibling
    elseif sibling.parent then
        sibling.parent.firstChild = sibling
    end
    self.prev = sibling
    return sibling
end

function Node:walker()
    local current, entering, root = self, true, self
    return function()
        if not current then
            return
        end
        local node, entry = current, entering
        if entering and containers[node.type] then
            if node.firstChild then
                current, entering = node.firstChild, true
            else
                entering = false
            end
        elseif node == root then
            current = nil
        elseif node.next then
            current, entering = node.next, true
        else
            current, entering = node.parent, false
        end
        return node, entry
    end
end

function Node:isContainer()
    return not not containers[self.type]
end

M.Node = Node
