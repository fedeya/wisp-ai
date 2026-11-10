-- Offline CPU measurements, not a WoW frame-time benchmark.
-- Run from the repository root with Lua 5.1: lua addon/tests/benchmarks/markdown.lua
local ns = {
    Core = {},
    Chat = {},
    Transport = {},
    Character = {},
    Actions = {},
    Integrations = {},
    ChatHistory = {},
    Settings = {},
    UI = {},
    Inline = {},
    Panels = {},
    Advice = {},
}
local root = arg[1] or "addon/WispAI"
for _, name in ipairs({ "Syntax", "Block", "Parser" }) do
    assert(loadfile(root .. "/Markdown/" .. name .. ".lua"))("WispAI", ns)
end
for _, name in ipairs({
    "Markdown/Cache",
    "EmojiData",
    "Emoji",
    "MessageFormat",
    "Markdown/Links",
    "Markdown/InlineRenderer",
    "Markdown/ReplyView",
}) do
    assert(loadfile("addon/WispAI/" .. name .. ".lua"))("WispAI", ns)
end

local function median(values)
    table.sort(values)
    return values[math.floor(#values / 2) + 1] * 1000
end
local function peak(values)
    local maximum = 0
    for _, value in ipairs(values) do
        maximum = math.max(maximum, value)
    end
    return maximum * 1000
end
local cases = {
    { "plain", string.rep("ordinary text ", 1500):sub(1, 20000) },
    {
        "dense",
        string
            .rep("**strong** *emphasis* [link](https://example.com) `literal` ~old~ ", 400)
            :sub(1, 20000),
    },
    {
        "table",
        "A|B|C|D|E|F\n---|---|---|---|---|---\n"
            .. string.rep("one|two|three|four|five|six\n", 700),
    },
}
print(
    "case\tbytes\tsync_parse_ms\tasync_cpu_ms\tpeak_step_ms\tsteps\tpresentation_ms\tcached_view_ms"
)
for _, case in ipairs(cases) do
    local times = { {}, {}, {}, {}, {}, {} }
    for _ = 1, 7 do
        collectgarbage("collect")
        local cache = ns.Markdown.Cache.New({ clock = os.clock })
        ns.Markdown.Cache.Get = function(...)
            return cache:get(...)
        end
        local source, start = case[2], os.clock()
        assert(ns.Markdown.Parse(source, { references = true }))
        times[1][#times[1] + 1] = os.clock() - start
        local _, _, pending = cache:get(source)
        local maximum, elapsed, steps = 0, 0, 0
        while pending do
            start = os.clock()
            cache:step()
            steps = steps + 1
            local used = os.clock() - start
            maximum, elapsed = math.max(maximum, used), elapsed + used
            local document, err
            document, err, pending = cache:get(source)
            assert(document or pending, err and err.code)
        end
        times[2][#times[2] + 1], times[3][#times[3] + 1] = elapsed, maximum
        times[6][#times[6] + 1] = steps
        local message = { role = "assistant", text = source }
        start = os.clock()
        ns.Markdown.ReplyView.Project(message)
        times[4][#times[4] + 1] = os.clock() - start
        start = os.clock()
        ns.Markdown.ReplyView.Project(message)
        times[5][#times[5] + 1] = os.clock() - start
    end
    print(
        string.format(
            "%s\t%d\t%.1f\t%.1f\t%.1f\t%d\t%.1f\t%.1f",
            case[1],
            #case[2],
            median(times[1]),
            median(times[2]),
            peak(times[3]),
            median(times[6]) / 1000,
            median(times[4]),
            median(times[5])
        )
    )
end
