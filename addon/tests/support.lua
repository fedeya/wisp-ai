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

function M.addon(name, env)
    if name == "MessageFormat.lua" and not env.C.Markdown then
        for _, dependency in ipairs({ "Syntax", "Block", "Parser" }) do
            M.addon("Markdown/" .. dependency .. ".lua", env)
        end
        M.addon("MarkdownCache.lua", env)
    end
    if name == "UI.lua" then
        for _, dependency in ipairs({
            "Widgets.lua",
            "EmojiData.lua",
            "Emoji.lua",
            "MessageFormat.lua",
            "MarkdownView.lua",
            "ModelControls.lua",
            "MessageRows.lua",
        }) do
            M.addon(dependency, env)
        end
    end
    local result = setfenv(assert(loadfile("addon/WispAI/" .. name)), env)("WispAI", env.C)
    if name == "MessageFormat.lua" then
        M.addon("MarkdownText.lua", env)
    end
    return result
end

return M
