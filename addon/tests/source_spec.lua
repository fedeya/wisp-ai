local lfs = require("lfs")

it("all addon source files compile as Lua", function()
    for name in lfs.dir("addon/WispAI") do
        if name:match("%.lua$") then
            local chunk, err = loadfile("addon/WispAI/" .. name)
            assert.is_function(chunk, err)
        end
    end
end)
