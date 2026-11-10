local _, C = ...
local M = C.Markdown
local Stream = {}
Stream.__index = Stream

local function completePrefix(source)
    local start = #source
    while start > 0 do
        local byte = source:byte(start)
        if byte < 0x80 or byte >= 0xC0 then
            break
        end
        start = start - 1
    end
    if start < 1 then
        return source
    end
    local first = source:byte(start)
    local needed = first >= 0xC2 and first <= 0xDF and 2
        or (first >= 0xE0 and first <= 0xEF and 3)
        or (first >= 0xF0 and first <= 0xF4 and 4)
    if not needed or #source - start + 1 >= needed then
        return source
    end
    local second = source:byte(start + 1)
    if
        second
        and (
            (first == 0xE0 and second < 0xA0)
            or (first == 0xED and second >= 0xA0)
            or (first == 0xF0 and second < 0x90)
            or (first == 0xF4 and second >= 0x90)
        )
    then
        return source
    end
    return source:sub(1, start - 1)
end

function M.newStream(options)
    local config, err = M._options(options)
    if not config then
        return nil, err
    end
    return setmetatable({ _options = config, _chunks = {}, bytes = 0, revision = 0 }, Stream)
end

function Stream:feed(chunk)
    if self._closed then
        return nil, { code = "closed" }
    end
    if type(chunk) ~= "string" then
        return nil, { code = "invalid_source" }
    end
    if self.bytes + #chunk > self._options.maxBytes then
        return nil, { code = "max_bytes", limit = self._options.maxBytes }
    end
    if chunk ~= "" then
        self._chunks[#self._chunks + 1] = chunk
        self.bytes, self.revision = self.bytes + #chunk, self.revision + 1
    end
    return true
end

function Stream:source()
    if self._sourceRevision ~= self.revision then
        self._source = table.concat(self._chunks)
        self._chunks = { self._source }
        self._sourceRevision = self.revision
    end
    return self._source or ""
end

function Stream:snapshot()
    if self._cachedRevision == self.revision then
        return self._document, self._error
    end
    local document, err = M.parse(completePrefix(self:source()), self._options)
    if document then
        document.complete = false
    end
    self._document, self._error, self._cachedRevision = document, err, self.revision
    return document, err
end

function Stream:finish()
    if self._closed then
        return self._document
    end
    local document, err = M.parse(self:source(), self._options)
    if not document then
        return nil, err
    end
    document.complete = true
    self._closed, self._document, self._error, self._cachedRevision =
        true, document, nil, self.revision
    return document
end
