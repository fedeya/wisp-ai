-- Container continuation, lazy paragraphs and tab columns follow commonmark.js.
-- See Markdown/LICENSE-commonmark.txt for the upstream BSD license.
local _, C = ...
local M = C.Markdown
local U = M.Scanner
local Block = {}
Block.__index = Block

local htmlNames = {}
for name in
    (
        "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt "
        .. "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link "
        .. "main menu menuitem nav noframes ol optgroup option p param section search summary table tbody td tfoot th thead title tr track ul"
    ):gmatch("%S+")
do
    htmlNames[name] = true
end

local function isBlank(s)
    return not s:find("[^ \t\r\n]")
end
local function space(c)
    return c == " " or c == "\t"
end
local function accepts(node)
    return node.type == "paragraph" or node.type == "code_block" or node.type == "html_block"
end
local function contains(parent, kind)
    return (parent.type == "document" or parent.type == "block_quote" or parent.type == "item")
            and kind ~= "item"
        or parent.type == "list" and kind == "item"
end

local function content(node)
    if node._content == nil then
        node._content = #node._lines > 0 and table.concat(node._lines, "\n") .. "\n" or ""
    end
    return node._content
end

local function htmlStart(line, pos)
    if line:sub(pos, pos) ~= "<" then
        return
    end
    local name = line:match("^<([A-Za-z]+)", pos)
    if name then
        local lower, after = name:lower(), line:sub(pos + #name + 1, pos + #name + 1)
        if
            (lower == "script" or lower == "pre" or lower == "textarea" or lower == "style")
            and (after == "" or after == ">" or after:match("%s"))
        then
            return 1
        end
    end
    if line:sub(pos, pos + 3) == "<!--" then
        return 2
    end
    if line:sub(pos, pos + 1) == "<?" then
        return 3
    end
    if line:find("^<![A-Za-z]", pos) then
        return 4
    end
    if line:sub(pos, pos + 8) == "<![CDATA[" then
        return 5
    end
    local _, last, tag = line:find("^</?([A-Za-z][A-Za-z0-9%-]*)", pos)
    if tag and htmlNames[tag:lower()] then
        local rest = line:sub(last + 1)
        if rest == "" or rest:match("^[ \t]") or rest:match("^/?>") then
            return 6
        end
    end
    local finish = U.htmlTag(line, pos)
    if finish and isBlank(line:sub(finish)) then
        return 7
    end
end

local function htmlEnd(kind, line, pos)
    if kind == 1 then
        local lower = line:sub(pos):lower()
        return lower:find("</script>", 1, true)
            or lower:find("</pre>", 1, true)
            or lower:find("</textarea>", 1, true)
            or lower:find("</style>", 1, true)
    end
    local marker = ({ [2] = "-->", [3] = "?>", [4] = ">", [5] = "]]>" })[kind]
    return marker and line:find(marker, pos, true)
end

function Block.new(options, newNode)
    local self = setmetatable({ options = options, newNode = newNode }, Block)
    self.inline = M.Inline.new(options, newNode)
    self.refmap = {}
    self.doc = self:newNode("document", { { 1, 1 }, { 0, 0 } })
    self.doc._depth = 0
    self.tip, self.lineNumber, self.lastLength = self.doc, 0, 0
    return self
end

function Block:advance(count, columns)
    while count > 0 and self.offset <= #self.line do
        local char = self.line:sub(self.offset, self.offset)
        if char == "\t" then
            local toTab = 4 - self.column % 4
            if columns then
                local consumed = math.min(toTab, count)
                self.partialTab = toTab > count
                self.column, count = self.column + consumed, count - consumed
                if not self.partialTab then
                    self.offset = self.offset + 1
                end
            else
                self.partialTab = false
                self.column, self.offset, count = self.column + toTab, self.offset + 1, count - 1
            end
        else
            self.partialTab = false
            self.offset, self.column, count = self.offset + 1, self.column + 1, count - 1
        end
    end
end

function Block:findNonspace()
    local pos, column = self.offset, self.column
    while pos <= #self.line do
        local char = self.line:sub(pos, pos)
        if char == " " then
            column, pos = column + 1, pos + 1
        elseif char == "\t" then
            column, pos = column + 4 - column % 4, pos + 1
        else
            break
        end
    end
    self.nonspace, self.nonspaceColumn = pos, column
    self.blank = pos > #self.line
    self.indent = column - self.column
    self.indented = self.indent >= 4
end

function Block:advanceNonspace()
    self.offset, self.column, self.partialTab = self.nonspace, self.nonspaceColumn, false
end

function Block:addLine()
    local line = self.line:sub(self.offset)
    if self.partialTab then
        line = string.rep(" ", 4 - self.column % 4) .. self.line:sub(self.offset + 1)
    end
    self.tip._lines[#self.tip._lines + 1] = line
    self.tip._lineSource = self.tip._lineSource or {}
    self.tip._lineSource[#self.tip._lineSource + 1] = { column = self.offset, length = #self.line }
    self.tip._content = nil
end

function Block:addChild(kind, offset)
    while not contains(self.tip, kind) do
        self:finalize(self.tip, self.lineNumber - 1)
    end
    local node = self:newNode(kind, { { self.lineNumber, offset }, { 0, 0 } })
    node._lines = {}
    node._depth = self.tip._depth + 1
    if node._depth > self.options.maxNesting then
        error({ markdownLimit = true, code = "max_nesting", line = self.lineNumber }, 0)
    end
    self.tip:appendChild(node)
    self.tip = node
    return node
end

function Block:closeUnmatched()
    if not self.allClosed then
        while self.oldTip ~= self.lastMatched do
            local parent = self.oldTip.parent
            self:finalize(self.oldTip, self.lineNumber - 1)
            self.oldTip = parent
        end
        self.allClosed = true
    end
end

function Block:stripDefinitions(node)
    local value, offset, lines = content(node), 1, 0
    while value:sub(offset, offset) == "[" do
        local consumed = self.inline:parseReference(value:sub(offset), self.refmap)
        if consumed == 0 then
            break
        end
        local _, count = value:sub(offset, offset + consumed - 1):gsub("\n", "")
        lines, offset = lines + count, offset + consumed
    end
    node._content = value:sub(offset)
    node._lines = node._content == "" and {} or nil
    if node._lineSource and node._lineSource[lines + 1] then
        node.sourcepos[1][2] = node._lineSource[lines + 1].column
    end
    node._lineSource = node._content == "" and {} or nil
    node.sourcepos[1][1] = node.sourcepos[1][1] + lines
    return offset > 1
end

local function endsBlank(node)
    return node.next and node.sourcepos[2][1] ~= node.next.sourcepos[1][1] - 1
end

function Block:finalize(node, lineNumber)
    local parent = node.parent
    node._open = false
    node.sourcepos[2] = { lineNumber, self.lastLength }
    if node.type == "document" then
        local empty = {}
        for child, entering in node:walker() do
            if
                entering
                and child.type == "paragraph"
                and self:stripDefinitions(child)
                and isBlank(child._content)
            then
                empty[#empty + 1] = child
            end
        end
        for _, child in ipairs(empty) do
            child:unlink()
        end
    elseif node.type == "list" then
        local item = node.firstChild
        while item do
            if endsBlank(item) then
                node.listTight = false
                break
            end
            local child = item.firstChild
            while child do
                if endsBlank(child) then
                    node.listTight = false
                    break
                end
                child = child.next
            end
            item = item.next
        end
        node.sourcepos[2] = node.lastChild.sourcepos[2]
    elseif node.type == "item" then
        if node.lastChild then
            node.sourcepos[2] = node.lastChild.sourcepos[2]
        else
            node.sourcepos[2] =
                { node.sourcepos[1][1], node.sourcepos[1][2] + node._list.markerLength - 1 }
        end
    elseif node.type == "code_block" then
        local lines = node._lines
        if node._fenced then
            node.info = U.unescape(U.trim(lines[1] or ""))
            node.literal = #lines > 1 and table.concat(lines, "\n", 2) .. "\n" or ""
        else
            while #lines > 0 and isBlank(lines[#lines]) do
                table.remove(lines)
            end
            node.literal = table.concat(lines, "\n") .. "\n"
            node.sourcepos[2] = {
                node.sourcepos[1][1] + #lines - 1,
                node._lineSource[#lines].length,
            }
        end
        node._lines, node._content = nil, nil
    elseif node.type == "html_block" then
        node.literal = content(node):gsub("\n$", "")
        node._lines, node._content = nil, nil
    end
    self.tip = parent
end

function Block:continues(node)
    if node.type == "document" or node.type == "list" then
        return 0
    elseif node.type == "block_quote" then
        if not self.indented and self.line:sub(self.nonspace, self.nonspace) == ">" then
            self:advanceNonspace()
            self:advance(1, false)
            if space(self.line:sub(self.offset, self.offset)) then
                self:advance(1, true)
            end
            return 0
        end
        return 1
    elseif node.type == "item" then
        if self.blank then
            if not node.firstChild then
                return 1
            end
            self:advanceNonspace()
        elseif self.indent >= node._list.markerOffset + node._list.padding then
            self:advance(node._list.markerOffset + node._list.padding, true)
        else
            return 1
        end
        return 0
    elseif node.type == "heading" or node.type == "thematic_break" then
        return 1
    elseif node.type == "code_block" then
        if node._fenced then
            local marker = self.line:match("^([`~]+)[ \t]*$", self.nonspace)
            if
                self.indent <= 3
                and marker
                and marker:sub(1, 1) == node._fenceChar
                and not marker:find("[^" .. node._fenceChar .. "]")
                and #marker >= node._fenceLength
            then
                self.lastLength = self.nonspace - 1 + #marker
                self:finalize(node, self.lineNumber)
                return 2
            end
            local count = node._fenceOffset
            while count > 0 and space(self.line:sub(self.offset, self.offset)) do
                self:advance(1, true)
                count = count - 1
            end
        elseif self.indent >= 4 then
            self:advance(4, true)
        elseif self.blank then
            self:advanceNonspace()
        else
            return 1
        end
        return 0
    elseif node.type == "table" then
        if self.blank then
            return 1
        end
        local rest = self.line:sub(self.nonspace)
        if not self.indented then
            local hashes = rest:match("^(#+)[ \t]")
            local fence = rest:match("^(```+)") or rest:match("^(~~~+)")
            local list = rest:match("^[*+%-][ \t]") or rest:match("^%d+[.)][ \t]")
            local compact = rest:gsub("[ \t]", "")
            local rule = #compact >= 3
                and (compact:match("^%*+$") or compact:match("^%-+$") or compact:match("^_+$"))
            if
                rest:sub(1, 1) == ">"
                or (hashes and #hashes <= 6)
                or fence
                or list
                or rule
                or htmlStart(self.line, self.nonspace)
            then
                return 1
            end
        end
        M.Extensions.tableRow(
            self,
            node,
            M.Extensions.cells(rest),
            false,
            self.lineNumber,
            self.nonspace
        )
        self.lastLength = #self.line
        return 2
    elseif node.type == "html_block" then
        return self.blank and node._htmlType >= 6 and 1 or 0
    elseif node.type == "paragraph" then
        return self.blank and 1 or 0
    end
    return 1
end

function Block:listMarker(container)
    if self.indent >= 4 then
        return
    end
    local start = self.nonspace
    local bullet = self.line:match("^([*+%-])", start)
    local number, delimiter
    if not bullet then
        number, delimiter = self.line:match("^(%d+)([.)])", start)
    end
    if
        not bullet
        and (not number or #number > 9 or (container.type == "paragraph" and tonumber(number) ~= 1))
    then
        return
    end
    local length = bullet and 1 or #number + 1
    local after = self.line:sub(start + length, start + length)
    if after ~= "" and not space(after) then
        return
    end
    if container.type == "paragraph" and isBlank(self.line:sub(start + length)) then
        return
    end
    local data = {
        type = bullet and "bullet" or "ordered",
        bullet = bullet,
        start = number and tonumber(number),
        delimiter = delimiter,
        markerOffset = self.indent,
        markerLength = length,
    }
    self:advanceNonspace()
    self:advance(length, true)
    local column, offset = self.column, self.offset
    repeat
        self:advance(1, true)
    until self.column - column >= 5 or not space(self.line:sub(self.offset, self.offset))
    local blank = self.offset > #self.line
    local padding = self.column - column
    if padding >= 5 or padding < 1 or blank then
        data.padding = length + 1
        self.column, self.offset = column, offset
        if space(self.line:sub(self.offset, self.offset)) then
            self:advance(1, true)
        end
    else
        data.padding = length + padding
    end
    return data
end

function Block:starts(container)
    local char = self.line:sub(self.nonspace, self.nonspace)
    if not self.indented and char == ">" then
        local start = self.nonspace
        self:advanceNonspace()
        self:advance(1, false)
        if space(self.line:sub(self.offset, self.offset)) then
            self:advance(1, true)
        end
        self:closeUnmatched()
        self:addChild("block_quote", start)
        return 1
    end
    if not self.indented and char == "#" then
        local hashes, following = self.line:match("^(#+)(.*)$", self.nonspace)
        if #hashes <= 6 and (following == "" or following:match("^[ \t]")) then
            local start = self.nonspace
            self:advanceNonspace()
            self:advance(#hashes, false)
            while space(self.line:sub(self.offset, self.offset)) do
                self:advance(1, false)
            end
            self:closeUnmatched()
            local heading = self:addChild("heading", start)
            heading.level = #hashes
            heading._content =
                self.line:sub(self.offset):gsub("^[ \t]*#+[ \t]*$", ""):gsub("[ \t]+#+[ \t]*$", "")
            self:advance(#self.line - self.offset + 1, false)
            return 2
        end
    end
    if not self.indented and (char == "`" or char == "~") then
        local marker = self.line:match(char == "`" and "^(`+)" or "^(~+)", self.nonspace)
        if
            marker
            and #marker >= 3
            and (char ~= "`" or not self.line:find("`", self.nonspace + #marker, true))
        then
            self:closeUnmatched()
            local node = self:addChild("code_block", self.nonspace)
            node._fenced, node._fenceLength, node._fenceChar, node._fenceOffset =
                true, #marker, char, self.indent
            self:advanceNonspace()
            self:advance(#marker, false)
            return 2
        end
    end
    if not self.indented and char == "<" then
        local kind = htmlStart(self.line, self.nonspace)
        local lazy = not self.allClosed and not self.blank and self.tip.type == "paragraph"
        if kind and (kind < 7 or (container.type ~= "paragraph" and not lazy)) then
            self:closeUnmatched()
            self:addChild("html_block", self.offset)._htmlType = kind
            return 2
        end
    end
    if self.options.gfm and not self.indented and M.Extensions.startTable(self, container) then
        return 2
    end
    if
        not self.indented
        and container.type == "paragraph"
        and (
            self.line:match("^=+[ \t]*$", self.nonspace)
            or self.line:match("^%-+[ \t]*$", self.nonspace)
        )
    then
        self:closeUnmatched()
        self:stripDefinitions(container)
        if #container._content > 0 then
            local heading = self:newNode("heading", container.sourcepos)
            heading.level = char == "=" and 1 or 2
            heading._content, heading._depth = container._content, container._depth
            container:insertAfter(heading)
            container:unlink()
            self.tip = heading
            self:advance(#self.line - self.offset + 1, false)
            return 2
        end
    end
    if not self.indented and (char == "*" or char == "_" or char == "-") then
        local compact = self.line:sub(self.nonspace):gsub("[ \t]", "")
        if
            #compact >= 3
            and not compact:find(
                "[^" .. (char == "-" and "%-" or char == "*" and "%*" or char) .. "]"
            )
        then
            self:closeUnmatched()
            self:addChild("thematic_break", self.nonspace)
            self:advance(#self.line - self.offset + 1, false)
            return 2
        end
    end
    if not self.indented or container.type == "list" then
        local data = self:listMarker(container)
        if data then
            self:closeUnmatched()
            local old = container._list
            if
                self.tip.type ~= "list"
                or not old
                or old.type ~= data.type
                or old.delimiter ~= data.delimiter
                or old.bullet ~= data.bullet
            then
                local node = self:addChild("list", self.nonspace)
                node._list, node.listType, node.listStart, node.listDelimiter, node.listTight =
                    data, data.type, data.start, data.delimiter, true
            end
            self:addChild("item", self.nonspace)._list = data
            return 1
        end
    end
    if self.indented and self.tip.type ~= "paragraph" and not self.blank then
        self:advance(4, true)
        self:closeUnmatched()
        self:addChild("code_block", self.offset)
        return 2
    end
    return 0
end

function Block:lineAt(line)
    local container, allMatched = self.doc, true
    self.oldTip = self.tip
    self.offset, self.column, self.blank, self.partialTab = 1, 0, false, false
    self.lineNumber, self.line = self.lineNumber + 1, line
    while container.lastChild and container.lastChild._open do
        container = container.lastChild
        self:findNonspace()
        local result = self:continues(container)
        if result == 2 then
            return
        end
        if result == 1 then
            allMatched = false
            container = container.parent
            break
        end
    end
    self.allClosed, self.lastMatched = container == self.oldTip, container
    local matchedLeaf = container.type ~= "paragraph" and accepts(container)
    while not matchedLeaf do
        self:findNonspace()
        local char = self.line:sub(self.nonspace, self.nonspace)
        local tableCandidate = self.options.gfm
            and container.type == "paragraph"
            and char:find("[|:%-]")
        if not tableCandidate and not self.indented and not char:find("[#`~*+_=<>%d%-]") then
            self:advanceNonspace()
            break
        end
        local result = self:starts(container)
        if result == 0 then
            self:advanceNonspace()
            break
        end
        container = self.tip
        matchedLeaf = result == 2
    end
    if not self.allClosed and not self.blank and self.tip.type == "paragraph" then
        self:addLine()
    else
        self:closeUnmatched()
        if accepts(container) then
            self:addLine()
            if
                container.type == "html_block" and htmlEnd(container._htmlType, line, self.offset)
            then
                self.lastLength = #line
                self:finalize(container, self.lineNumber)
            end
        elseif self.offset <= #line and not self.blank then
            self:addChild("paragraph", self.offset)
            self:advanceNonspace()
            self:addLine()
        end
    end
    self.lastLength = #line
end

function Block:parse(source)
    local pos = 1
    while true do
        local newline = source:find("\n", pos, true)
        if not newline then
            if pos <= #source or #source == 0 then
                self:lineAt(source:sub(pos))
            end
            break
        end
        self:lineAt(source:sub(pos, newline - 1))
        pos = newline + 1
    end
    while self.tip do
        self:finalize(self.tip, self.lineNumber)
    end
    self.inline.refmap = self.refmap
    for node, entering in self.doc:walker() do
        if
            not entering
            and (node.type == "paragraph" or node.type == "heading" or node.type == "table_cell")
        then
            if self.options.gfm then
                M.Extensions.task(node)
            end
            self.inline:parse(node)
        end
    end
    return self.doc
end

M.Block = Block
