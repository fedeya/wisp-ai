local _, C = ...

-- Syntax depends on source and inline/block mode, never on references, item data
-- or width. Presentation caches can keep their compiled strings after AST eviction.
local MAX_SOURCE, MAX_NODES, MAX_NESTING = 65536, 20000, 128
local SYNC_BYTES, FRAME_BUDGET, MAX_RESUMES = 512, 0.002, 8
local Cache = {}
Cache.__index = Cache

local function clock()
    if GetTimePreciseSec then
        return GetTimePreciseSec()
    elseif debugprofilestop then
        return debugprofilestop() / 1000
    end
    return GetTime and GetTime() or 0
end

local function removePending(self, entry)
    if not entry.pending then
        return
    end
    if entry.before then
        entry.before.after = entry.after
    else
        self.firstPending = entry.after
    end
    if entry.after then
        entry.after.before = entry.before
    else
        self.lastPending = entry.before
    end
    entry.before, entry.after, entry.pending = nil, nil, false
    self.pendingCount = self.pendingCount - 1
end

local function promotePending(self, entry)
    if entry == self.lastPending then
        return
    end
    if entry.pending then
        removePending(self, entry)
    end
    entry.pending, entry.before = true, self.lastPending
    if self.lastPending then
        self.lastPending.after = entry
    else
        self.firstPending = entry
    end
    self.lastPending = entry
    self.pendingCount = self.pendingCount + 1
end

local function removeLRU(self, entry)
    if entry.older then
        entry.older.newer = entry.newer
    else
        self.oldest = entry.newer
    end
    if entry.newer then
        entry.newer.older = entry.older
    else
        self.newest = entry.older
    end
    entry.older, entry.newer = nil, nil
end

local function touch(self, entry)
    if self.newest == entry then
        return
    end
    removeLRU(self, entry)
    entry.older = self.newest
    if self.newest then
        self.newest.newer = entry
    else
        self.oldest = entry
    end
    self.newest = entry
end

local function drop(self, entry)
    removePending(self, entry)
    removeLRU(self, entry)
    self.entries[entry.mode][entry.source] = nil
    self.count, self.bytes = self.count - 1, self.bytes - #entry.source
    entry.task = nil
end

local function makeRoom(self, bytes, urgent)
    while self.count >= self.maxEntries or self.bytes + bytes > self.maxBytes do
        local candidate = self.oldest
        while candidate and candidate.pending do
            candidate = candidate.newer
        end
        if candidate then
            drop(self, candidate)
        elseif urgent and self.firstPending then
            drop(self, self.firstPending)
            self.revision = self.revision + 1
        else
            return false
        end
    end
    return true
end

local function limits()
    return {
        references = true,
        maxBytes = MAX_SOURCE,
        maxNodes = MAX_NODES,
        maxNesting = MAX_NESTING,
    }
end

function Cache:get(source, inline, urgent)
    if type(source) ~= "string" then
        return nil, { code = "invalid_source" }, false
    end
    local maximum = math.min(MAX_SOURCE, self.maxBytes)
    if #source > maximum then
        return nil, { code = "max_bytes", limit = maximum }, false
    end
    local mode = inline and 2 or 1
    local entry = self.entries[mode][source]
    if entry then
        touch(self, entry)
        if entry.pending then
            promotePending(self, entry)
            return nil, nil, true
        end
        return entry.document, entry.error, false
    end

    local synchronous = #source <= self.syncBytes
    if not synchronous and self.pendingCount >= self.maxPending then
        if urgent then
            drop(self, self.firstPending)
            self.revision = self.revision + 1
        else
            -- Retry admission after another document completes. No work is started
            -- or discarded on each refresh while the queue is already full.
            return nil, { code = "busy" }, true
        end
    end
    if not makeRoom(self, #source, urgent) then
        if synchronous then
            local parse = inline and C.Markdown.parseInline or C.Markdown.parse
            local document, err = parse(source, limits())
            return document, err, false
        end
        return nil, { code = "busy" }, true
    end

    entry = { source = source, mode = mode }
    self.entries[mode][source] = entry
    self.count, self.bytes = self.count + 1, self.bytes + #source
    entry.older = self.newest
    if self.newest then
        self.newest.newer = entry
    else
        self.oldest = entry
    end
    self.newest = entry
    if synchronous then
        local parse = inline and C.Markdown.parseInline or C.Markdown.parse
        local ok, document, err = pcall(parse, source, limits())
        if not ok then
            drop(self, entry)
            error(document, 0)
        end
        entry.document, entry.error = document, err
        return entry.document, entry.error, false
    end
    local ok, task = pcall(C.Markdown._newTask, source, limits(), inline == true)
    if not ok or type(task) ~= "thread" then
        drop(self, entry)
        error(ok and "Markdown task constructor must return a coroutine" or task, 0)
    end
    entry.task = task
    promotePending(self, entry)
    if self.onSchedule then
        self.onSchedule(self)
    end
    return nil, nil, true
end

function Cache:step()
    if self.running then
        return 0, self.pendingCount
    end
    self.running = true
    local deadline = self.clock() + self.budget
    local resumed, completed = 0, 0
    while self.lastPending do
        local entry = self.lastPending
        local ok, document, err = coroutine.resume(entry.task)
        resumed = resumed + 1
        if not ok then
            if type(document) == "table" and document.markdownLimit then
                err = {}
                for key, value in pairs(document) do
                    if key ~= "markdownLimit" then
                        err[key] = value
                    end
                end
                document = nil
            else
                drop(self, entry)
                self.running = false
                error(document, 0)
            end
        elseif coroutine.status(entry.task) ~= "dead" then
            document = nil
        elseif not document and not err then
            drop(self, entry)
            self.running = false
            error("Markdown task finished without a document or error", 0)
        end
        if document or err then
            removePending(self, entry)
            entry.document, entry.error, entry.task = document, err, nil
            completed = completed + 1
            self.revision = self.revision + 1
        end
        if resumed >= self.maxResumes or self.clock() >= deadline then
            break
        end
    end
    if completed > 0 and self.onReady then
        local ok, err = pcall(self.onReady, self)
        self.running = false
        if not ok then
            error(err, 0)
        end
    else
        self.running = false
    end
    return completed, self.pendingCount
end

function Cache:cancel(source, inline)
    if type(source) ~= "string" then
        return false
    end
    local entry = self.entries[inline and 2 or 1][source]
    if not entry or not entry.pending then
        return false
    end
    drop(self, entry)
    self.revision = self.revision + 1
    return true
end

local function new(options)
    options = options or {}
    return setmetatable({
        entries = { {}, {} },
        count = 0,
        bytes = 0,
        pendingCount = 0,
        revision = 0,
        maxEntries = options.maxEntries or 128,
        maxBytes = options.maxBytes or 524288,
        maxPending = options.maxPending or 32,
        syncBytes = options.syncBytes == nil and SYNC_BYTES or options.syncBytes,
        budget = options.budget or FRAME_BUDGET,
        maxResumes = options.maxResumes or MAX_RESUMES,
        clock = options.clock or clock,
        onReady = options.onReady,
        onSchedule = options.onSchedule,
    }, Cache)
end

local frame, default
local api = { revision = 0, new = new }
local function wake()
    if not frame then
        frame = CreateFrame("Frame")
        frame:SetScript("OnUpdate", function()
            local _, pending = api.step()
            if pending == 0 then
                frame:Hide()
            end
        end)
    end
    frame:Show()
end
default = new({
    onSchedule = wake,
    onReady = function(cache)
        api.revision = cache.revision
        if C.Refresh then
            C.Refresh()
        end
        if C.RefreshInline then
            C.RefreshInline()
        end
        if C.RefreshPanels then
            C.RefreshPanels()
        end
    end,
})
function api.get(source, inline, urgent)
    local document, err, pending = default:get(source, inline, urgent)
    api.revision = default.revision
    return document, err, pending
end
function api.step()
    local completed, pending = default:step()
    api.revision = default.revision
    return completed, pending
end
function api.cancel(source, inline)
    local cancelled = default:cancel(source, inline)
    api.revision = default.revision
    if default.pendingCount == 0 and frame then
        frame:Hide()
    end
    return cancelled
end
C.MarkdownCache = api
