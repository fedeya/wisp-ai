import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// Real production reader/Inspect and the maintained RPC fixture, not a JS reader.
// Fengari is Lua 5.3; only the support helper's Lua 5.1 environment API is adapted.
export function observeLockouts(updated: boolean | 'oversized' = false) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const check = (status: number) => {
    if (status !== lua.LUA_OK) throw Error(to_jsstring(lua.lua_tolstring(state, -1)));
  };
  let output = '';
  try {
    lua.lua_pushcfunction(state, () => {
      output = to_jsstring(lua.lua_tolstring(state, 1));
      return 0;
    });
    lua.lua_setglobal(state, to_luastring('print'));
    check(
      lauxlib.luaL_dostring(
        state,
        to_luastring(`
          arg = { ${JSON.stringify(updated === 'oversized' ? updated : updated ? 'updated' : 'initial')} }
          unpack = table.unpack
          function setfenv(fn, env)
            local index = 1
            while true do
              local name = debug.getupvalue(fn, index)
              if not name then break end
              if name == '_ENV' then
                debug.upvaluejoin(fn, index, function() return env end, 1)
                break
              end
              index = index + 1
            end
            return fn
          end
        `),
      ),
    );
    check(lauxlib.luaL_dofile(state, to_luastring('addon/tests/fixtures/lockouts-rpc.lua')));
    return JSON.parse(output);
  } finally {
    lua.lua_close(state);
  }
}
