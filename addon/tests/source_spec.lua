local lfs = require("lfs")
local helper = require("addon.tests.support")
local root = "addon/WispAI/"

local function sources(directory, result)
    for name in lfs.dir(root .. directory) do
        if name ~= "." and name ~= ".." then
            local relative = directory .. name
            if lfs.attributes(root .. relative, "mode") == "directory" then
                sources(relative .. "/", result)
            elseif name:match("%.lua$") then
                result[relative] = true
            end
        end
    end
end

local function manifest()
    local files = {}
    for line in io.lines(root .. "WispAI.toc") do
        if line:match("%.lua$") then
            files[#files + 1] = line:gsub("\\", "/")
        end
    end
    return files
end

it(
    "the manifest includes every Lua source exactly once and each file compiles as Lua 5.1",
    function()
        local remaining = {}
        sources("", remaining)
        for _, name in ipairs(manifest()) do
            assert.is_true(remaining[name], "Missing or duplicate source: " .. name)
            local chunk, err = loadfile(root .. name)
            assert.is_function(chunk, err)
            remaining[name] = nil
        end
        assert.same({}, remaining)
    end
)

it(
    "loads the real manifest in order with a private namespace and a narrow public binding API",
    function()
        local env = helper.env()
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        local ns = {}
        env.time = function()
            return 123
        end
        env.strmatch = string.match
        env.SlashCmdList = {}
        for _, name in ipairs(manifest()) do
            setfenv(assert(loadfile(root .. name)), env)("WispAI", ns)
        end
        assert.is_function(ns.Chat.Submit)
        assert.is_function(ns.Character.Capture)
        assert.is_function(ns.Character.Inspect)
        assert.is_function(ns.Actions.PerformAction)
        assert.is_function(ns.Transport.StartTransport)
        assert.is_function(ns.UI.BuildUI)
        assert.is_function(ns.UI.Memory.Refresh)
        assert.is_function(ns.Markdown.TextStyle.Render)
        assert.is_nil(env.ns)
        assert.is_nil(env.C)
        assert.not_equals(ns, env.WispAI)
        local keys = {}
        for key in pairs(env.WispAI) do
            keys[#keys + 1] = key
        end
        assert.same({ "ActivateInline" }, keys)
        local activation
        ns.Inline.ActivateInline = function(key)
            activation = key
        end
        env.WispAI.ActivateInline("CTRL-W")
        assert.equals("CTRL-W", activation)
    end
)
