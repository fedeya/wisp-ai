local M = {}

-- Each former VM becomes a private WoW global environment. Addon closures and
-- callbacks keep this environment, including code compiled through load().
function M.env()
    local env = {}
    for key, value in pairs(_G) do
        env[key] = value
    end
    for _, key in ipairs({ "table", "string", "math", "os", "io", "utf8", "coroutine" }) do
        env[key] = {}
        for name, value in pairs(_G[key]) do
            env[key][name] = value
        end
    end
    env._G = env
    env.load = function(source, name, mode, target)
        return load(source, name, mode, target or env)
    end
    return env
end

function M.fixture(path, env)
    return assert(loadfile(path, "t", env))()
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
    return assert(loadfile("addon/WispAI/" .. name, "t", env))("WispAI", env.C)
end

return M
