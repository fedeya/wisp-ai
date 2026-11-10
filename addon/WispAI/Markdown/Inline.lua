-- Block/inline separation and delimiter/bracket stacks follow commonmark.js 0.31.2.
-- See Markdown/LICENSE-commonmark.txt for the upstream BSD license.
local _, C = ...
local M = C.Markdown
local U = M.Scanner
local Inline = {}
Inline.__index = Inline

local function text(parser, literal)
    local node = parser:newNode("text")
    node.literal = literal
    return node
end

function Inline.new(options, newNode)
    return setmetatable({ options = options, newNode = newNode, refmap = {} }, Inline)
end

function Inline:spaces()
    local _, ending = self.subject:find("^[ \t]*", self.pos)
    self.pos = ending + 1
    if self.subject:sub(self.pos, self.pos) == "\n" then
        _, ending = self.subject:find("^[ \t]*", self.pos + 1)
        self.pos = ending + 1
    end
end

function Inline:removeDelimiter(delim)
    if delim.previous then
        delim.previous.next = delim.next
    end
    if delim.next then
        delim.next.previous = delim.previous
    else
        self.delimiters = delim.previous
    end
end

function Inline:delimitersAt(block, char)
    local start = self.pos
    local pos = start
    while self.subject:sub(pos, pos) == char do
        pos = pos + 1
    end
    local count = pos - start
    local before = U.previous(self.subject, start)
    local after = U.codepoint(self.subject, pos)
    local beforeSpace, afterSpace = U.whitespace(before), U.whitespace(after)
    local beforePunctuation, afterPunctuation = U.punctuation(before), U.punctuation(after)
    local left = not afterSpace and (not afterPunctuation or beforeSpace or beforePunctuation)
    local right = not beforeSpace and (not beforePunctuation or afterSpace or afterPunctuation)
    local canOpen = left and (char ~= "_" or not right or beforePunctuation)
    local canClose = right and (char ~= "_" or not left or afterPunctuation)
    local node = block:appendChild(text(self, self.subject:sub(start, pos - 1)))
    self.pos = pos
    if (canOpen or canClose) and (char ~= "~" or count <= 2) then
        local delim = {
            char = char,
            count = count,
            original = count,
            node = node,
            canOpen = canOpen,
            canClose = canClose,
            previous = self.delimiters,
        }
        node._delimiter = delim
        if self.delimiters then
            self.delimiters.next = delim
        end
        self.delimiters = delim
    end
end

function Inline:processEmphasis(bottom)
    local closer = self.delimiters
    local lowerBounds = {}
    while closer and closer.previous ~= bottom do
        closer = closer.previous
    end
    while closer do
        if not closer.canClose then
            closer = closer.next
        else
            local key = closer.char
                .. (closer.canOpen and "1" or "0")
                .. (closer.char == "~" and closer.original or closer.original % 3)
            local opener, found = closer.previous, false
            while opener and opener ~= bottom and opener ~= lowerBounds[key] do
                local odd = closer.char ~= "~"
                    and (closer.canOpen or opener.canClose)
                    and closer.original % 3 ~= 0
                    and (opener.original + closer.original) % 3 == 0
                if
                    opener.char == closer.char
                    and opener.canOpen
                    and not odd
                    and (closer.char ~= "~" or opener.original == closer.original)
                then
                    found = true
                    break
                end
                opener = opener.previous
            end
            if found then
                local used = closer.char == "~" and closer.count
                    or (closer.count >= 2 and opener.count >= 2 and 2 or 1)
                opener.count, closer.count = opener.count - used, closer.count - used
                local emphasis = self:newNode(
                    closer.char == "~" and "strikethrough" or (used == 2 and "strong" or "emph")
                )
                local child = opener.node.next
                while child and child ~= closer.node do
                    local nextChild = child.next
                    emphasis:appendChild(child)
                    child = nextChild
                end
                opener.node:insertAfter(emphasis)
                opener.next, closer.previous = closer, opener
                if opener.count == 0 then
                    opener.node:unlink()
                    self:removeDelimiter(opener)
                end
                if closer.count == 0 then
                    local nextCloser = closer.next
                    closer.node:unlink()
                    self:removeDelimiter(closer)
                    closer = nextCloser
                end
            else
                lowerBounds[key] = closer.previous
                local old = closer
                closer = closer.next
                if not old.canOpen then
                    self:removeDelimiter(old)
                end
            end
        end
    end
    while self.delimiters and self.delimiters ~= bottom do
        self:removeDelimiter(self.delimiters)
    end
end

function Inline:addBracket(node, index, image)
    if self.brackets then
        self.brackets.bracketAfter = true
    end
    local previousLink = self.brackets
    if previousLink and previousLink.image then
        previousLink = previousLink.previousLink
    end
    self.brackets = {
        node = node,
        index = index,
        image = image,
        active = true,
        previous = self.brackets,
        previousDelimiter = self.delimiters,
        previousLink = previousLink,
    }
end

function Inline:label()
    local start, pos, count = self.pos, self.pos + 1, 0
    if self.subject:sub(start, start) ~= "[" then
        return 0
    end
    while pos <= #self.subject and count <= 999 do
        local char = self.subject:sub(pos, pos)
        if char == "]" then
            self.pos = pos + 1
            return self.pos - start
        end
        if char == "[" then
            return 0
        end
        if char == "\\" and pos < #self.subject then
            pos = pos + 1
            count = count + 1
        end
        local _, nextPos = U.codepoint(self.subject, pos)
        pos, count = nextPos, count + 1
    end
    return 0
end

function Inline:destination()
    local start, pos, depth = self.pos, self.pos, 0
    local angle = self.subject:sub(pos, pos) == "<"
    if angle then
        pos = pos + 1
        start = pos
    end
    while pos <= #self.subject do
        local char = self.subject:sub(pos, pos)
        if char == "\\" and U.escapable(self.subject:sub(pos + 1, pos + 1)) then
            pos = pos + 2
        elseif angle then
            if char == ">" then
                self.pos = pos + 1
                return U.normalizeURI(U.unescape(self.subject:sub(start, pos - 1)))
            elseif char == "<" or char == "\n" then
                return nil
            else
                pos = pos + 1
            end
        elseif char == "(" then
            depth, pos = depth + 1, pos + 1
            if depth > self.options.maxNesting then
                error({
                    markdownLimit = true,
                    code = "max_nesting",
                    context = "link_destination",
                    limit = self.options.maxNesting,
                }, 0)
            end
        elseif char == ")" then
            if depth == 0 then
                break
            end
            depth, pos = depth - 1, pos + 1
        elseif char == " " or char:byte() < 32 or char:byte() == 127 then
            break
        else
            pos = pos + 1
        end
    end
    if angle or depth ~= 0 or (pos == start and self.subject:sub(pos, pos) ~= ")") then
        return nil
    end
    self.pos = pos
    return U.normalizeURI(U.unescape(self.subject:sub(start, pos - 1)))
end

function Inline:title()
    local start = self.pos
    local char = self.subject:sub(start, start)
    local ending = char == "(" and ")" or char
    if char ~= '"' and char ~= "'" and char ~= "(" then
        return nil
    end
    local pos = start + 1
    while pos <= #self.subject do
        local current = self.subject:sub(pos, pos)
        if current == "\\" and pos < #self.subject then
            pos = pos + 2
        elseif current == ending then
            local value = self.subject:sub(start + 1, pos - 1)
            if value:find("\n[ \t]*\n") then
                return nil
            end
            self.pos = pos + 1
            return U.unescape(value)
        elseif char == "(" and current == "(" then
            return nil
        else
            pos = pos + 1
        end
    end
end

function Inline:closeBracket(block)
    self.pos = self.pos + 1
    local start = self.pos
    local opener = self.brackets
    if not opener or not opener.active then
        if opener then
            self.brackets = opener.previous
        end
        block:appendChild(text(self, "]"))
        return
    end
    local destination, title, matched
    if self.subject:sub(self.pos, self.pos) == "(" then
        self.pos = self.pos + 1
        self:spaces()
        destination = self:destination()
        if destination then
            local beforeSpace = self.pos
            self:spaces()
            if self.pos > beforeSpace then
                title = self:title()
            end
            self:spaces()
            if self.subject:sub(self.pos, self.pos) == ")" then
                self.pos, matched = self.pos + 1, true
            end
        end
        if not matched then
            self.pos = start
        end
    end
    if not matched then
        local beforeLabel = self.pos
        local length = self:label()
        local label
        if length > 2 then
            label = self.subject:sub(beforeLabel + 1, beforeLabel + length - 2)
        elseif not opener.bracketAfter then
            local cursor, characters = opener.index + 1, 0
            while cursor < start - 1 and characters <= 999 do
                local _, nextPos = U.codepoint(self.subject, cursor)
                cursor, characters = nextPos, characters + 1
            end
            if characters <= 999 then
                label = self.subject:sub(opener.index + 1, start - 2)
            end
        end
        if length == 0 then
            self.pos = start
        end
        local reference = label and self.refmap[U.normalizeReference(label)]
        if reference then
            destination, title, matched = reference.destination, reference.title, true
        end
    end
    if not matched then
        self.brackets, self.pos = opener.previous, start
        block:appendChild(text(self, "]"))
        return
    end
    local node = self:newNode(opener.image and "image" or "link")
    node.destination, node.title = destination, title or ""
    local child = opener.node.next
    while child do
        local nextChild = child.next
        node:appendChild(child)
        child = nextChild
    end
    block:appendChild(node)
    self:processEmphasis(opener.previousDelimiter)
    self.brackets = opener.previous
    opener.node:unlink()
    if not opener.image then
        local previous = opener.previousLink
        while previous and previous.active do
            previous.active = false
            previous = previous.previousLink
        end
    end
end

local function emailAddress(value)
    local name, domain = value:match("^([^@]+)@([^@]+)$")
    if not name or name:find("[^A-Za-z0-9.!#$%%&'*+/=?^_`{|}~%-]") then
        return false
    end
    if
        domain:find("[^A-Za-z0-9%.%-]")
        or domain:sub(1, 1) == "."
        or domain:sub(-1) == "."
        or domain:find("..", 1, true)
    then
        return false
    end
    for label in domain:gmatch("[^.]+") do
        if
            #label > 63
            or not label:sub(1, 1):match("[A-Za-z0-9]")
            or not label:sub(-1):match("[A-Za-z0-9]")
        then
            return false
        end
    end
    return true
end

function Inline:autolink(block)
    local _, ending, value = self.subject:find("^<([^<>%z\1-\32]*)>", self.pos)
    if not ending then
        return false
    end
    local destination
    if emailAddress(value) then
        destination = "mailto:" .. value
    else
        local scheme = value:match("^([A-Za-z][A-Za-z0-9+%.%-]*):")
        if scheme and #scheme >= 2 and #scheme <= 32 then
            destination = value
        end
    end
    if not destination then
        return false
    end
    local node = self:newNode("link")
    node.destination, node.title = U.normalizeURI(destination), ""
    node:appendChild(text(self, value))
    block:appendChild(node)
    self.pos = ending + 1
    return true
end

-- Pre-index complete backtick runs once; unmatched runs never rescan the suffix.
function Inline:indexBackticks()
    local runs, pos = {}, 1
    while true do
        local first, last = self.subject:find("`+", pos)
        if not first then
            break
        end
        runs[#runs + 1] = { first, last - first + 1 }
        pos = last + 1
    end
    local nextByLength = {}
    self.backticks = {}
    self.ticksByLength = {}
    for _, run in ipairs(runs) do
        local positions = self.ticksByLength[run[2]] or {}
        positions[#positions + 1] = run[1]
        self.ticksByLength[run[2]] = positions
    end
    for i = #runs, 1, -1 do
        local start, length = runs[i][1], runs[i][2]
        self.backticks[start] = { length = length, finish = nextByLength[length] }
        nextByLength[length] = start
    end
end

function Inline:backtickRun()
    local run = self.backticks[self.pos]
    if run then
        return run
    end
    -- An escape can consume the first tick of an indexed run. The remaining
    -- suffix is a new opener, while closing runs still require an exact length.
    local _, ending = self.subject:find("^`+", self.pos)
    local length = ending - self.pos + 1
    local positions = self.ticksByLength[length] or {}
    local low, high, finish = 1, #positions, nil
    while low <= high do
        local middle = math.floor((low + high) / 2)
        if positions[middle] > ending then
            finish, high = positions[middle], middle - 1
        else
            low = middle + 1
        end
    end
    run = { length = length, finish = finish }
    self.backticks[self.pos] = run
    return run
end

function Inline:htmlTag()
    local source, start = self.subject, self.pos
    local marker = ">"
    if source:sub(start, start + 3) == "<!--" then
        if source:sub(start, start + 4) == "<!-->" or source:sub(start, start + 5) == "<!--->" then
            return U.htmlTag(source, start)
        end
        marker = "-->"
    elseif source:sub(start, start + 1) == "<?" then
        marker = "?>"
    elseif source:sub(start, start + 8) == "<![CDATA[" then
        marker = "]]>"
    end
    local last = self.htmlEnds[marker]
    if last == nil then
        local pos = 1
        last = 0
        while true do
            local found = source:find(marker, pos, true)
            if not found then
                break
            end
            last, pos = found, found + #marker
        end
        self.htmlEnds[marker] = last
    end
    if start > last then
        return
    end
    return U.htmlTag(source, start)
end

function Inline:parse(block, trim)
    self.subject = trim == false and (block._content or "") or U.trim(block._content or "")
    self.pos, self.delimiters, self.brackets = 1, nil, nil
    self:indexBackticks()
    self.urls, self.urlIndex =
        self.options.gfm and M.Extensions.urlCandidates(self.subject) or {}, 1
    self.urlStop, self.urlSkipUntil = nil, nil
    self.htmlEnds = {}
    while self.pos <= #self.subject do
        local start, char = self.pos, self.subject:sub(self.pos, self.pos)
        while self.urls[self.urlIndex] and self.urls[self.urlIndex].start < self.pos do
            self.urlIndex = self.urlIndex + 1
        end
        local candidate = not self.brackets and self.urls[self.urlIndex]
        local url, destination, ending
        if candidate and candidate.start == self.pos then
            url, destination, ending = M.Extensions.url(self, candidate)
            self.urlIndex = self.urlIndex + 1
        end
        if url then
            local node = self:newNode("link")
            node.destination, node.title = destination, ""
            node:appendChild(text(self, url))
            block:appendChild(node)
            self.pos = ending
        elseif char == "\n" then
            local last = block.lastChild
            local hard = last and last.type == "text" and last.literal:match("  $")
            if last and last.type == "text" then
                last.literal = last.literal:gsub(" +$", "")
            end
            block:appendChild(self:newNode(hard and "linebreak" or "softbreak"))
            local _, ending = self.subject:find("^ *", self.pos + 1)
            self.pos = ending + 1
        elseif char == "\\" then
            local following = self.subject:sub(self.pos + 1, self.pos + 1)
            if following == "\n" then
                block:appendChild(self:newNode("linebreak"))
                self.pos = self.pos + 2
            elseif U.escapable(following) then
                block:appendChild(text(self, following))
                self.pos = self.pos + 2
            else
                block:appendChild(text(self, "\\"))
                self.pos = self.pos + 1
            end
        elseif char == "`" then
            local run = self:backtickRun()
            if run.finish then
                local contents =
                    self.subject:sub(self.pos + run.length, run.finish - 1):gsub("\n", " ")
                if
                    contents:sub(1, 1) == " "
                    and contents:sub(-1) == " "
                    and contents:find("[^ ]")
                then
                    contents = contents:sub(2, -2)
                end
                local code = self:newNode("code")
                code.literal = contents
                block:appendChild(code)
                self.pos = run.finish + run.length
            else
                block:appendChild(text(self, string.rep("`", run.length)))
                self.pos = self.pos + run.length
            end
        elseif char == "*" or char == "_" or (char == "~" and self.options.gfm) then
            self:delimitersAt(block, char)
        elseif char == "[" then
            local ending, key
            if self.options.references then
                local first
                first, ending, key =
                    self.subject:find("^%[%[ref:([A-Za-z][A-Za-z0-9_%-]*)%]%]", self.pos)
            end
            if ending and #key <= 64 then
                local node = self:newNode("reference")
                node.key = key
                node.literal = self.subject:sub(self.pos, ending)
                block:appendChild(node)
                self.pos = ending + 1
            else
                local node = block:appendChild(text(self, "["))
                self:addBracket(node, self.pos, false)
                self.pos = self.pos + 1
            end
        elseif char == "!" then
            if self.subject:sub(self.pos + 1, self.pos + 1) == "[" then
                local node = block:appendChild(text(self, "!["))
                self:addBracket(node, self.pos + 1, true)
                self.pos = self.pos + 2
            else
                block:appendChild(text(self, "!"))
                self.pos = self.pos + 1
            end
        elseif char == "]" then
            self:closeBracket(block)
        elseif char == "<" then
            if not self:autolink(block) then
                local ending = self:htmlTag()
                if ending then
                    local node = self:newNode("html_inline")
                    node.literal = self.subject:sub(self.pos, ending - 1)
                    block:appendChild(node)
                    self.pos = ending
                end
            end
        elseif char == "&" then
            local value, ending = U.entity(self.subject, self.pos)
            if value then
                block:appendChild(text(self, value))
                self.pos = ending
            end
        else
            local first = self.subject:find(
                "[\n\\`*_%[!%]<&" .. (self.options.gfm and "~" or "") .. "]",
                self.pos
            )
            local ending = first and first - 1 or #self.subject
            candidate = not self.brackets and self.urls[self.urlIndex]
            if candidate and candidate.start > self.pos then
                ending = math.min(ending, candidate.start - 1)
            end
            if ending >= self.pos then
                block:appendChild(text(self, self.subject:sub(self.pos, ending)))
                self.pos = ending + 1
            end
        end
        if self.pos == start then
            block:appendChild(text(self, char))
            self.pos = self.pos + 1
        end
    end
    self:processEmphasis(nil)
    for node, entering in block:walker() do
        if entering and node._delimiter then
            local delim = node._delimiter
            if delim.count ~= delim.original then
                node.literal = string.rep(delim.char, delim.count)
            end
            node._delimiter = nil
        end
    end
    if self.options.gfm then
        M.Extensions.emails(self, block)
    end
    block._content = nil
end

function Inline:parseReference(source, refmap)
    self.subject, self.pos = source, 1
    local length = self:label()
    if length == 0 or self.subject:sub(self.pos, self.pos) ~= ":" then
        return 0
    end
    local label = U.normalizeReference(source:sub(2, length - 1))
    if label == "" then
        return 0
    end
    self.pos = self.pos + 1
    self:spaces()
    local destination = self:destination()
    if not destination then
        return 0
    end
    local beforeTitle = self.pos
    self:spaces()
    local title
    if self.pos ~= beforeTitle then
        title = self:title()
    end
    if not title then
        self.pos = beforeTitle
    end
    local function lineEnd()
        local _, ending = self.subject:find("^[ \t]*", self.pos)
        local pos = ending + 1
        local c = self.subject:sub(pos, pos)
        if c == "\n" then
            self.pos = pos + 1
            return true
        end
        if c == "" then
            self.pos = pos
            return true
        end
        return false
    end
    if not lineEnd() then
        if not title then
            return 0
        end
        title, self.pos = nil, beforeTitle
        if not lineEnd() then
            return 0
        end
    end
    if not refmap[label] then
        refmap[label] = { destination = destination, title = title or "" }
    end
    return self.pos - 1
end

M.Inline = Inline
