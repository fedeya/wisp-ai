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
    if name == "UI.lua" then
        for _, dependency in ipairs({
            "Widgets.lua",
            "EmojiData.lua",
            "Emoji.lua",
            "MessageFormat.lua",
            "ModelControls.lua",
            "MessageRows.lua",
        }) do
            M.addon(dependency, env)
        end
    end
    return setfenv(assert(loadfile("addon/WispAI/" .. name)), env)("WispAI", env.C)
end

return M
