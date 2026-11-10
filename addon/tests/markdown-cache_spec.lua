local helper = require("addon.tests.support")

local function setup(options)
    local env, state = helper.env(), { calls = {}, now = 0, resumed = {}, ready = 0 }
    env.C = { Markdown = {} }
    local markdown = env.C.Markdown
    local function parse(source, limits, inline)
        state.calls[#state.calls + 1] = { source, inline, limits }
        if source == "failure" then
            return nil, { code = "max_nodes", limit = limits.maxNodes }
        elseif source == "syncbug" then
            error("unexpected synchronous bug", 0)
        end
        return { source = source, inline = inline }
    end
    markdown.parse = function(source, limits)
        return parse(source, limits, false)
    end
    markdown.parseInline = function(source, limits)
        return parse(source, limits, true)
    end
    markdown._newTask = function(source, limits, inline)
        return coroutine.create(function()
            for index = 1, 4 do
                state.resumed[#state.resumed + 1] = source
                state.now = state.now + 0.00075
                coroutine.yield()
            end
            if source == "bug" then
                error("unexpected parser bug", 0)
            elseif source == "limit" then
                error({ markdownLimit = true, code = "max_nodes", limit = limits.maxNodes }, 0)
            end
            return parse(source, limits, inline)
        end)
    end
    helper.addon("Markdown/Cache.lua", env)
    options = options or {}
    options.clock = function()
        return state.now
    end
    options.onReady = options.onReady or function()
        state.ready = state.ready + 1
    end
    return env.C.Markdown.Cache.new(options), state, env
end

local function drain(cache)
    local pending = 1
    for _ = 1, 100 do
        local _, left = cache:step()
        pending = left
        if pending == 0 then
            return
        end
    end
    error("cache did not drain")
end

it("reuses syntax only by exact source and inline mode, including errors", function()
    local cache, state = setup()
    local first, err, pending = cache:get("**same**")
    assert.is_nil(err)
    assert.is_false(pending)
    assert.equal(first, cache:get("**same**", false))
    assert.equal(1, #state.calls)
    local inline = cache:get("**same**", true)
    assert.are_not.equal(first, inline)
    assert.is_true(inline.inline)
    assert.equal(2, #state.calls)
    assert.is_true(state.calls[1][3].references)
    local document, failure = cache:get("failure")
    assert.is_nil(document)
    assert.equal("max_nodes", failure.code)
    local _, same = cache:get("failure")
    assert.equal(failure, same)
    assert.equal(3, #state.calls)
    assert.has_error(function()
        cache:get("syncbug")
    end, "unexpected synchronous bug")
    assert.is_nil(cache.entries[1].syncbug)
end)

it("yields long documents across steps within a shared approximate time budget", function()
    local cache, state = setup({ syncBytes = 0 })
    local document, err, pending = cache:get("first")
    assert.is_nil(document)
    assert.is_nil(err)
    assert.is_true(pending)
    cache:get("second")
    local completed, left = cache:step()
    assert.equal(0, completed)
    assert.equal(2, left)
    assert.equal(3, #state.resumed)
    assert.same({ "second", "second", "second" }, state.resumed)
    assert.is_true(state.now < 0.003, "only the final cooperative chunk can cross the deadline")
    drain(cache)
    assert.equal(2, #state.calls)
    assert.equal("first", cache:get("first").source)
    assert.equal("second", cache:get("second").source)
    assert.equal(2, cache.revision)
    assert.is_true(state.ready > 0)
end)

it("bounds work even when the clock does not advance", function()
    local cache, state = setup({ syncBytes = 0, maxResumes = 2 })
    cache.clock = function()
        return 0
    end
    cache:get("one")
    cache:step()
    assert.equal(2, #state.resumed)
    assert.equal(0, #state.calls)
    drain(cache)
    assert.equal(1, #state.calls)
end)

it("does not cancel queued history on refresh and prioritizes an urgent reply", function()
    local cache, state = setup({ syncBytes = 0, maxPending = 2 })
    cache:get("oldest")
    cache:get("history")
    local _, busy, pending = cache:get("deferred")
    assert.equal("busy", busy.code)
    assert.is_true(pending)
    assert.equal(2, cache.pendingCount)
    assert.equal(0, cache.revision)
    cache:get("streaming", false, true)
    assert.equal(1, cache.revision, "the displaced row can retry when presentation refreshes")
    assert.equal(2, cache.pendingCount)
    cache:step()
    assert.equal("streaming", state.resumed[1])
    drain(cache)
    assert.same({ "streaming", "history" }, { state.calls[1][1], state.calls[2][1] })
    assert.is_nil(cache.entries[1].oldest)
end)

it("uses LRU eviction and source-byte limits without evicting pending work for history", function()
    local cache, state = setup({ maxEntries = 2 })
    local first = cache:get("one")
    cache:get("two")
    assert.equal(first, cache:get("one"))
    cache:get("three")
    assert.is_nil(cache.entries[1].two)
    assert.equal(first, cache:get("one"))
    assert.equal(3, #state.calls)
    local bounded = setup({ maxBytes = 12, syncBytes = 0 })
    bounded:get("123456")
    bounded:get("abcdef")
    local _, err, pending = bounded:get("next")
    assert.equal("busy", err.code)
    assert.is_true(pending)
    assert.equal(12, bounded.bytes)
    drain(bounded)
    bounded:get("next")
    assert.is_true(bounded.bytes <= 12)
end)

it(
    "cancels obsolete work, releases its coroutine and keeps completed or other-mode syntax",
    function()
        local cache, state = setup({ syncBytes = 0 })
        cache:get("obsolete")
        cache:step()
        local weak = setmetatable({ cache.entries[1].obsolete.task }, { __mode = "v" })
        local resumed = #state.resumed
        assert.is_true(cache:cancel("obsolete"))
        assert.equal(1, cache.revision)
        assert.equal(0, cache.pendingCount)
        assert.equal(0, cache.bytes)
        collectgarbage("collect")
        assert.is_nil(weak[1], "cancelled coroutines must not retain obsolete source trees")
        drain(cache)
        assert.equal(resumed, #state.resumed)
        assert.equal(0, #state.calls)
        assert.is_false(cache:cancel("obsolete"))
        assert.is_false(cache:cancel({}))
        cache:get("shared")
        cache:get("shared", true)
        assert.is_true(cache:cancel("shared"))
        assert.equal(1, cache.pendingCount)
        drain(cache)
        local complete = cache:get("shared", true)
        local revision = cache.revision
        assert.is_true(complete.inline)
        assert.is_false(cache:cancel("shared", true))
        assert.equal(complete, cache:get("shared", true))
        assert.equal(revision, cache.revision)
        assert.equal(1, #state.calls)
    end
)

it(
    "returns byte bounds immediately and distinguishes parser limits from programming failures",
    function()
        local cache, state = setup({ syncBytes = 0 })
        local _, invalid, pending = cache:get({})
        assert.equal("invalid_source", invalid.code)
        assert.is_false(pending)
        local _, oversized = cache:get(string.rep("x", 65537))
        assert.equal("max_bytes", oversized.code)
        assert.equal(65536, oversized.limit)
        assert.equal(0, cache.pendingCount)
        cache:get("limit")
        drain(cache)
        local _, limit = cache:get("limit")
        assert.same({ code = "max_nodes", limit = 20000 }, limit)
        cache:get("bug")
        assert.has_error(function()
            drain(cache)
        end, "unexpected parser bug")
        assert.equal(0, cache.pendingCount)
        assert.is_nil(cache.entries[1].bug)
        assert.equal(0, #state.calls)
    end
)

it("defers cancellation notification so another consumer of shared syntax can retry", function()
    local cache, state, retry
    cache, state = setup({
        syncBytes = 0,
        onReady = function(current)
            state.ready = state.ready + 1
            if retry then
                retry = false
                local document, err, pending = current:get("shared")
                assert.is_nil(document)
                assert.is_nil(err)
                assert.is_true(pending)
            end
        end,
    })
    cache:get("shared")
    cache:get("shared")
    assert.equal(1, cache.pendingCount, "both consumers share one syntax job")
    retry = true
    assert.is_true(cache:cancel("shared"))
    assert.equal(0, cache.pendingCount)
    assert.equal(0, state.ready, "cancellation must not refresh within the current render")
    local completed, pending = cache:step()
    assert.equal(0, completed)
    assert.equal(1, pending, "a surviving consumer can enqueue again during the deferred refresh")
    assert.equal(1, state.ready)
    assert.equal(0, #state.resumed, "the abandoned coroutine was never resumed")
    drain(cache)
    assert.equal(1, #state.calls)
    assert.equal("shared", cache:get("shared").source)
end)

it("batches completion callbacks and protects stepping from callback reentrancy", function()
    local cache, state
    cache, state = setup({
        syncBytes = 0,
        budget = 1,
        maxResumes = 16,
        onReady = function(current)
            state.ready = state.ready + 1
            assert.equal(0, current:step())
        end,
    })
    cache:get("one")
    cache:get("two")
    drain(cache)
    assert.equal(1, state.ready)
    assert.equal(2, cache.revision)
end)

it("starts a lazy frame scheduler and coalesces transcript, inline and panel refreshes", function()
    local _, state, env = setup()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.GetTimePreciseSec = function()
        return state.now
    end
    local full, inline, panels = 0, 0, 0
    env.C.Refresh = function()
        full = full + 1
    end
    env.C.RefreshInline = function()
        inline = inline + 1
    end
    env.C.RefreshPanels = function()
        panels = panels + 1
    end
    local before = #env.UI_TEST.widgets
    local api = env.C.Markdown.Cache
    local source = string.rep("x", 513)
    local _, _, pending = api.get(source)
    assert.is_true(pending)
    assert.equal(before + 1, #env.UI_TEST.widgets)
    local frame = env.UI_TEST.widgets[#env.UI_TEST.widgets]
    assert.is_true(frame:IsShown())
    for _ = 1, 8 do
        frame.scripts.OnUpdate()
        if not frame:IsShown() then
            break
        end
    end
    assert.is_false(frame:IsShown())
    assert.equal(1, full)
    assert.equal(1, inline)
    assert.equal(1, panels)
    assert.equal(1, api.revision)
    assert.equal(source, api.get(source).source)
    assert.equal(before + 1, #env.UI_TEST.widgets, "cache hits never create another frame")
    local other = source .. "new"
    api.get(other)
    assert.is_true(frame:IsShown())
    assert.is_true(api.cancel(other))
    assert.is_true(frame:IsShown(), "a deferred cancellation notification still needs one frame")
    assert.equal(1, full, "cancellation must not refresh reentrantly")
    frame.scripts.OnUpdate()
    assert.is_false(frame:IsShown())
    assert.equal(2, full)
    assert.equal(2, inline)
    assert.equal(2, panels)
    assert.equal(2, api.revision)
    assert.is_false(api.cancel(source), "cancellation preserves completed documents")
end)
