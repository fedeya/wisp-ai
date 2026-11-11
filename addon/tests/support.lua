local M = {}

-- WoW globals and callbacks belong to one scenario, using Lua 5.1 environments.
function M.env()
    local env = {}
    for key, value in pairs(_G) do
        env[key] = value
    end
    for _, key in ipairs({ "table", "string", "math", "os", "io", "coroutine" }) do
        env[key] = {}
        for name, value in pairs(_G[key]) do
            env[key][name] = value
        end
    end
    env._G = env
    return env
end

function M.fixture(path, env)
    return setfenv(assert(loadfile(path)), env)()
end

function M.namespace(initial)
    local ns = initial or {}
    assert(loadfile("addon/WispAI/Namespace.lua"))("WispAI", ns)
    return ns
end

function M.addon(name, env)
    setfenv(assert(loadfile("addon/WispAI/Namespace.lua")), env)("WispAI", env.ns)
    if not env.ns.Shared.Numbers.IsFinite then
        setfenv(assert(loadfile("addon/WispAI/Shared/Numbers.lua")), env)("WispAI", env.ns)
    end
    if not env.ns.Shared.Text.TruncateUtf8Bytes then
        setfenv(assert(loadfile("addon/WispAI/Shared/Text.lua")), env)("WispAI", env.ns)
    end
    if name == "UI/RichUI.lua" and not env.ns.UI.Widgets then
        M.addon("UI/Widgets.lua", env)
    end
    if name == "UI/MessageFormat.lua" and not env.ns.Markdown then
        for _, dependency in ipairs({ "Syntax", "Block", "Parser" }) do
            M.addon("Markdown/" .. dependency .. ".lua", env)
        end
        M.addon("Markdown/Cache.lua", env)
    end
    if name == "UI/Window.lua" then
        for _, dependency in ipairs({
            "UI/Widgets.lua",
            "UI/RichUI.lua",
            "UI/EmojiData.lua",
            "UI/Emoji.lua",
            "UI/MessageFormat.lua",
            "Markdown/ReplyView.lua",
            "Markdown/TextStyle.lua",
            "UI/ModelControls.lua",
            "UI/MessageRows.lua",
            "UI/Capabilities.lua",
            "UI/Memory.lua",
        }) do
            M.addon(dependency, env)
        end
    end
    local result = setfenv(assert(loadfile("addon/WispAI/" .. name)), env)("WispAI", env.ns)
    if name == "UI/MessageFormat.lua" then
        M.addon("Markdown/Links.lua", env)
        M.addon("Markdown/InlineRenderer.lua", env)
    elseif name == "Core.lua" then
        for _, dependency in ipairs({
            "Transport/ResponseTiming.lua",
            "Chat/State.lua",
            "Chat/Snapshot.lua",
            "UI/Sound.lua",
        }) do
            M.addon(dependency, env)
        end
    end
    return result
end

function M.rendered(font)
    local text = font:IsShown() and font:GetText() or ""
    for _, run in ipairs(font.runs or {}) do
        if run:IsShown() then
            text = text .. run:GetText()
        end
    end
    return text
end

function M.rowText(row)
    if row.text:IsShown() then
        return row.text:GetText()
    end
    local parts = {}
    for _, font in ipairs(row.rich and row.rich.prose or {}) do
        parts[#parts + 1] = M.rendered(font)
    end
    return table.concat(parts)
end

return M
