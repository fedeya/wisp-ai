import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Exit, Schema } from 'effect';
import { guideGoal, guideInput } from '@wisp/agent/contract/game-actions';
import { rejectUnknownKeys } from '@wisp/protocol/checks';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// A field of any goal type.
type FieldOf<Goal> = Goal extends { readonly fields: infer Fields } ? Fields[keyof Fields] : never;
type Field = FieldOf<(typeof guideGoal.members)[number]>;
// Each goal's fields, typed as `Field`, which `Object.entries` cannot infer for a union.
const fieldsOf = (fields: { readonly [key: string]: Field }) => Object.entries(fields);

// Whether `field`, as a goal's `key`, accepts `goal`, which has that key or not.
const accepts = (key: string, field: Field, goal: object) =>
  Exit.isSuccess(Schema.decodeUnknownExit(Schema.Struct({ [key]: field }))(goal));

// The first sample a field accepts: names, IDs, coordinates, levels.
function sample(key: string, field: Field) {
  return ['Name', 1, 50, 10, true].find((value) => accepts(key, field, { [key]: value }));
}

// The schema gates what the agent sends; the addon checks the same required
// fields before handing goals to Polestar. A field the schema lets through but
// Lua requires would refuse valid requests in game, so both lists must match.
test('the addon requires exactly the goal fields the protocol schema requires', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const check = (status: number) => {
    if (status !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  const push = (value: unknown) => {
    if (typeof value === 'string') {
      lua.lua_pushstring(L, to_luastring(value));
    } else if (typeof value === 'number') {
      lua.lua_pushinteger(L, value);
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(L, value);
    } else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((entry, index) => {
        push(entry);
        lua.lua_rawseti(L, -2, index + 1);
      });
    } else {
      lua.lua_newtable(L);
      for (const [key, entry] of Object.entries(value as object)) {
        push(entry);
        lua.lua_setfield(L, -2, to_luastring(key));
      }
    }
  };
  check(
    lauxlib.luaL_dostring(
      L,
      to_luastring(`
        ns = { db = {}, Integrations = {} }
        function time() return 1 end
        local guides = {}
        Polestar = {
          API = { version = 1, ReplaceSteps = function() return true end },
          Lookup = {
            RegisterPlanner = function(_, build) Polestar.build = build end,
            BuildGuide = function(kind, id)
              local guide, reason = Polestar.build(id)
              if guide then guide.id = "lookup/" .. kind .. "/" .. id end
              return guide, reason
            end,
          },
          RegisterGuide = function(guide) guides[guide.id] = guide return true end,
          Engine = { SetGuide = function() return true end },
        }
        function create(args)
          local ok, err = pcall(ns.Integrations.CreatePolestarGuide, args)
          return ok and "ok" or tostring(err)
        end
      `),
    ),
  );
  check(
    lauxlib.luaL_loadstring(
      L,
      to_luastring(readFileSync('addon/WispAI/Integrations/PolestarGuides.lua', 'utf8')),
    ),
  );
  lua.lua_pushstring(L, to_luastring('WispAI'));
  lua.lua_getglobal(L, to_luastring('ns'));
  check(lua.lua_pcall(L, 2, 0, 0));

  const create = (goal: Record<string, unknown>) => {
    const args = Schema.decodeUnknownSync(guideInput)(
      { title: 'Sync', steps: [{ goals: [goal] }] },
      rejectUnknownKeys,
    );
    lua.lua_getglobal(L, to_luastring('create'));
    push(args);
    check(lua.lua_pcall(L, 1, 1, 0));
    const result = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_pop(L, 1);
    return result;
  };

  expect(guideGoal.members).toHaveLength(18);
  for (const { fields } of guideGoal.members) {
    const type = fields.type.literal;
    const required = fieldsOf(fields).filter(
      ([key, field]) => key !== 'type' && !accepts(key, field, {}),
    );
    const goal: Record<string, unknown> = { type };
    for (const [key, field] of required) {
      goal[key] = sample(key, field);
    }
    expect(create(goal), `${type} with its required fields`).toBe('ok');
    for (const [key] of required) {
      // Lua must refuse what the schema refuses; skip its decode to reach it.
      const { [key]: _omitted, ...rest } = goal;
      lua.lua_getglobal(L, to_luastring('create'));
      push({ title: 'Sync', steps: [{ goals: [rest] }] });
      check(lua.lua_pcall(L, 1, 1, 0));
      const result = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      expect(result, `${type} without ${key}`).toContain(`needs ${key}`);
    }
  }
});
