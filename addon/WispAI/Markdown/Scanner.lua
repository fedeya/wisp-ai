local _, C = ...
local M = C.Markdown
local U = {}
M.Scanner = U

local replacement = "\239\191\189"
U.replacement = replacement

function U.char(code)
    if code == 0 or code > 0x10FFFF or (code >= 0xD800 and code <= 0xDFFF) then
        return replacement
    end
    if code < 0x80 then
        return string.char(code)
    end
    if code < 0x800 then
        return string.char(0xC0 + math.floor(code / 64), 0x80 + code % 64)
    end
    if code < 0x10000 then
        return string.char(
            0xE0 + math.floor(code / 4096),
            0x80 + math.floor(code / 64) % 64,
            0x80 + code % 64
        )
    end
    return string.char(
        0xF0 + math.floor(code / 262144),
        0x80 + math.floor(code / 4096) % 64,
        0x80 + math.floor(code / 64) % 64,
        0x80 + code % 64
    )
end

-- Decode one scalar without depending on a host UTF-8 library (WoW uses Lua 5.1).
function U.codepoint(text, pos)
    local a, b, c, d = text:byte(pos, pos + 3)
    if not a then
        return nil, pos
    end
    if a < 0x80 then
        return a, pos + 1
    end
    local function continuation(n)
        return n and n >= 0x80 and n <= 0xBF
    end
    if a >= 0xC2 and a <= 0xDF and continuation(b) then
        return (a - 0xC0) * 64 + b - 0x80, pos + 2
    end
    if
        a >= 0xE0
        and a <= 0xEF
        and continuation(b)
        and continuation(c)
        and not (a == 0xE0 and b < 0xA0)
        and not (a == 0xED and b >= 0xA0)
    then
        return (a - 0xE0) * 4096 + (b - 0x80) * 64 + c - 0x80, pos + 3
    end
    if
        a >= 0xF0
        and a <= 0xF4
        and continuation(b)
        and continuation(c)
        and continuation(d)
        and not (a == 0xF0 and b < 0x90)
        and not (a == 0xF4 and b >= 0x90)
    then
        return (a - 0xF0) * 262144 + (b - 0x80) * 4096 + (c - 0x80) * 64 + d - 0x80, pos + 4
    end
    return 0xFFFD, pos + 1
end

function U.previous(text, pos)
    local start = pos - 1
    while start > 1 and text:byte(start) >= 0x80 and text:byte(start) < 0xC0 do
        start = start - 1
    end
    if start < 1 then
        return 10
    end
    return U.codepoint(text, start)
end

function U.inRanges(value, ranges)
    local lo, hi = 1, #ranges / 2
    while lo <= hi do
        local middle = math.floor((lo + hi) / 2)
        local first, last = ranges[middle * 2 - 1], ranges[middle * 2]
        if value < first then
            hi = middle - 1
        elseif value > last then
            lo = middle + 1
        else
            return true
        end
    end
    return false
end

function U.whitespace(code)
    return not code
        or code == 9
        or code == 10
        or code == 12
        or code == 13
        or code == 32
        or code == 0xA0
        or code == 0x1680
        or (code >= 0x2000 and code <= 0x200A)
        or code == 0x202F
        or code == 0x205F
        or code == 0x3000
end

function U.punctuation(code)
    return code and U.inRanges(code, M.Data.punctuation) or false
end

function U.escapable(char)
    local b = char:byte()
    return b
            and ((b >= 33 and b <= 47) or (b >= 58 and b <= 64) or (b >= 91 and b <= 96) or (b >= 123 and b <= 126))
        or false
end

function U.trim(text)
    return (text:gsub("^[ \t\r\n]+", ""):gsub("[ \t\r\n]+$", ""))
end

function U.normalizeReference(label)
    label = U.trim(label):gsub("[ \t\r\n]+", " ")
    local result, pos = {}, 1
    while pos <= #label do
        local code, nextPos = U.codepoint(label, pos)
        result[#result + 1] = M.Data.casefold[code] or label:sub(pos, nextPos - 1)
        pos = nextPos
    end
    return table.concat(result)
end

-- Only semicolon-terminated HTML5 entities are recognized by CommonMark.
function U.entity(text, pos)
    if text:sub(pos, pos) ~= "&" then
        return
    end
    local first, last, digits = text:find("^&#[xX]([%da-fA-F]+);", pos)
    local base = 16
    if not first then
        first, last, digits = text:find("^&#(%d+);", pos)
        base = 10
    end
    if first and #digits <= (base == 16 and 6 or 7) then
        return U.char(tonumber(digits, base)), last + 1
    end
    local _, ending, name = text:find("^&([A-Za-z][A-Za-z0-9]+);", pos)
    if ending and M.Data.entities[name] then
        return M.Data.entities[name], ending + 1
    end
end

function U.unescape(text)
    local result, pos, start = {}, 1, 1
    while pos <= #text do
        local c = text:sub(pos, pos)
        local value, nextPos
        if c == "\\" and U.escapable(text:sub(pos + 1, pos + 1)) then
            value, nextPos = text:sub(pos + 1, pos + 1), pos + 2
        elseif c == "&" then
            value, nextPos = U.entity(text, pos)
        end
        if value then
            result[#result + 1], result[#result + 2] = text:sub(start, pos - 1), value
            pos, start = nextPos, nextPos
        else
            pos = pos + 1
        end
    end
    result[#result + 1] = text:sub(start)
    return table.concat(result)
end

function U.normalizeURI(uri)
    local out, pos = {}, 1
    while pos <= #uri do
        local byte, char = uri:byte(pos), uri:sub(pos, pos)
        if char == "%" and uri:sub(pos + 1, pos + 2):match("^%x%x$") then
            out[#out + 1], pos = uri:sub(pos, pos + 2), pos + 3
        else
            local encode = byte >= 0x80
                or char:match('[%c%z <>"{}|\\^`]')
                or char == "%"
                or char == "["
                or char == "]"
            out[#out + 1] = encode and string.format("%%%02X", byte) or char
            pos = pos + 1
        end
    end
    return table.concat(out)
end

-- A bounded scanner, not an HTML parser; raw HTML stays an opaque AST leaf.
function U.htmlTag(text, pos)
    if text:sub(pos, pos) ~= "<" then
        return
    end
    local ending
    if text:sub(pos, pos + 3) == "<!--" then
        if text:sub(pos + 4, pos + 4) == ">" then
            return pos + 5
        end
        if text:sub(pos + 4, pos + 5) == "->" then
            return pos + 6
        end
        ending = text:find("-->", pos + 4, true)
        return ending and ending + 3
    elseif text:sub(pos, pos + 1) == "<?" then
        ending = text:find("?>", pos + 2, true)
        return ending and ending + 2
    elseif text:sub(pos, pos + 8) == "<![CDATA[" then
        ending = text:find("]]>", pos + 9, true)
        return ending and ending + 3
    elseif text:find("^<![A-Za-z]", pos) then
        ending = text:find(">", pos + 3, true)
        return ending and ending + 1
    end
    local _, nameEnd = text:find("^</?[A-Za-z][A-Za-z0-9%-]*", pos)
    if not nameEnd then
        return
    end
    local index, closing = nameEnd + 1, text:sub(pos + 1, pos + 1) == "/"
    while index <= #text do
        local _, spaceEnd = text:find("^[ \t\r\n\f\v]+", index)
        local spaced = spaceEnd ~= nil
        if spaceEnd then
            index = spaceEnd + 1
        end
        if text:sub(index, index) == ">" then
            return index + 1
        end
        if not closing and text:sub(index, index + 1) == "/>" then
            return index + 2
        end
        if closing or not spaced then
            return
        end
        local _, attrEnd = text:find("^[A-Za-z_:][A-Za-z0-9_:%.%-]*", index)
        if not attrEnd then
            return
        end
        index = attrEnd + 1
        local _, afterSpace = text:find("^[ \t\r\n\f\v]*", index)
        local equal = (afterSpace or index - 1) + 1
        if text:sub(equal, equal) == "=" then
            index = equal + 1
            _, afterSpace = text:find("^[ \t\r\n\f\v]*", index)
            index = (afterSpace or index - 1) + 1
            local quote = text:sub(index, index)
            if quote == '"' or quote == "'" then
                local finish = text:find(quote, index + 1, true)
                if not finish then
                    return
                end
                index = finish + 1
            else
                local start = index
                while index <= #text and not text:sub(index, index):match("[%z\1-\32\"'=<>`]") do
                    index = index + 1
                end
                if index == start then
                    return
                end
            end
        end
    end
end
