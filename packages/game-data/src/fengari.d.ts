// fengari publishes no types. This declares the part of its Lua C API that
// runAtlasLoot calls, as fengari 0.1.5 implements it.
declare module 'fengari' {
  type LuaString = Uint8Array;
  interface LuaState {
    readonly __fengariState: unique symbol;
  }

  export const lua: {
    readonly LUA_OK: number;
    lua_createtable(L: LuaState, narr: number, nrec: number): void;
    lua_getglobal(L: LuaState, name: LuaString): number;
    lua_pcall(L: LuaState, nargs: number, nresults: number, msgh: number): number;
    lua_pushstring(L: LuaState, value: LuaString): void;
    lua_rawseti(L: LuaState, index: number, n: number): void;
    lua_setglobal(L: LuaState, name: LuaString): void;
    // null when the value is neither a string nor a number.
    lua_tolstring(L: LuaState, index: number): LuaString | null;
  };
  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadstring(L: LuaState, source: LuaString): number;
  };
  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };
  export function to_luastring(value: string): LuaString;
  export function to_jsstring(value: LuaString): string;
}
