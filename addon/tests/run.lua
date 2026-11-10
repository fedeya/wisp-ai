-- Resolve only the worktree's LuaRocks tree; no activation or global rocks needed.
package.path = "runtime/lua/share/lua/5.3/?.lua;runtime/lua/share/lua/5.3/?/init.lua;"
    .. package.path
local extension = package.config:sub(1, 1) == "\\" and "dll" or "so"
package.cpath = "runtime/lua/lib/lua/5.3/?." .. extension .. ";" .. package.cpath
require("busted.runner")({ standalone = false })
