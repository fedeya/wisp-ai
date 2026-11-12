import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// Synthetic host APIs, real production reader/dispatcher. Busted covers native Lua 5.1.
export function observeQuestRewards(options: { maximum?: boolean; transport?: boolean } = {}) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(state, -1)));
    }
  };
  const read = (at: number): any => {
    const index = lua.lua_absindex(state, at);
    const type = lua.lua_type(state, index);
    if (type === lua.LUA_TNIL) return undefined;
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(state, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(state, index);
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tolstring(state, index));
    if (type !== lua.LUA_TTABLE) throw Error('Unexpected Lua fixture type');
    const result: Record<string, unknown> = {};
    lua.lua_pushnil(state);
    while (lua.lua_next(state, index)) {
      const key =
        lua.lua_type(state, -2) === lua.LUA_TNUMBER
          ? String(lua.lua_tonumber(state, -2))
          : to_jsstring(lua.lua_tolstring(state, -2));
      result[key] = read(-1);
      lua.lua_pop(state, 1);
    }
    const keys = Object.keys(result);
    return keys.length && keys.every((key, i) => key === String(i + 1))
      ? Object.values(result)
      : result;
  };
  try {
    if (options.transport) run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
    run(`
      unpack = table.unpack
      ns = ns or {}
      time = function() return 123 end
      UnitName = function() return 'Mage' end
      CreateFrame = function() return {
        RegisterEvent = function() end,
        SetScript = function(_, _, fn) onRewardEvent = fn end,
      } end
      QuestFrameRewardPanel = { IsVisible = function() return true end }
      GetQuestID = function() return 42 end
      GetTitleText = function() return 'Solo reward fixture' end
      GetNumQuestChoices = function() return 3 end
      GetNumQuestRewards = function() return 1 end
      GetQuestItemInfoLootType = function() return 0 end
      GetQuestItemInfo = function(kind, index) return kind..index, nil, index, 2, true, 100 end
      GetQuestItemLink = function(kind, index) return 'item:100:'..kind..index end
      GetInventoryItemLink = function(_, slot) return 'item:200:equipped'..slot end
      C_Item = {
        GetItemInfo = function(link)
          if link:find('choice3') then return nil end
          return link, link, 2, 20, 10, 'Armor', 'Cloth', 1, 'INVTYPE_FINGER'
        end,
        GetItemStats = function(link) return { INT = link:find('choice1') and 4 or 2 } end,
      }
    `);
    if (options.maximum) {
      run(`
        local seed = 39
        local function diverse(length, alphabet)
          local chars = {}
          for i = 1, length do
            seed = (seed * 16807) % 2147483647
            local index = seed % #alphabet + 1
            chars[i] = alphabet:sub(index, index)
          end
          return table.concat(chars)
        end
        local alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
          .. string.char(34, 92, 10, 9)
        GetTitleText = function() return diverse(200, alphabet) .. 'éé' end
        GetNumQuestChoices = function() return 10 end
        GetNumQuestRewards = function() return 10 end
        GetQuestItemLink = function(kind, index)
          return 'item:100:' .. diverse(480, '0123456789:') .. ':' .. kind .. index
        end
        GetInventoryItemLink = function(_, slot)
          return 'item:200:' .. diverse(480, '0123456789:') .. ':' .. slot
        end
        C_Item.GetItemInfo = function(link)
          return diverse(160, alphabet) .. 'éé', link, 2, 20, 10, 'Armor', 'Cloth', 1, 'INVTYPE_FINGER'
        end
        C_Item.GetItemStats = function()
          local stats = {}
          for i = 1, 32 do stats[diverse(80, alphabet)] = 1000000000 end
          return stats
        end
      `);
    }
    for (const file of [
      'Namespace',
      'Shared/Numbers',
      'Shared/Text',
      'Character/Inspect',
      'Character/QuestRewards',
    ]) {
      run(
        `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + file + '.lua', 'utf8'))}))('WispAI', ns)`,
      );
    }
    run(`onRewardEvent(nil, 'QUEST_COMPLETE')
      observation = ns.Character.Inspect({ kind = 'quest_rewards', args = {} })
      return observation`);
    const observation = read(-1);
    lua.lua_pop(state, 1);
    if (!options.transport) return observation;

    // JSON and zlib are explicit fixture boundaries, not native C_EncodingUtil validation.
    let serializedBytes = 0;
    let compressedBytes = 0;
    lua.lua_getglobal(state, to_luastring('C_EncodingUtil'));
    lua.lua_pushcfunction(state, () => {
      const json = JSON.stringify(read(1));
      serializedBytes = Buffer.byteLength(json);
      lua.lua_pushstring(state, to_luastring(json));
      return 1;
    });
    lua.lua_setfield(state, -2, to_luastring('SerializeJSON'));
    lua.lua_pushcfunction(state, () => {
      const compressed = deflateSync(Buffer.from(lua.lua_tolstring(state, 1)));
      compressedBytes = compressed.length;
      lua.lua_pushlstring(state, compressed, compressed.length);
      return 1;
    });
    lua.lua_setfield(state, -2, to_luastring('CompressString'));
    lua.lua_pop(state, 1);
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/Transport/Transport.lua', 'utf8'))}))('WispAI', ns)`,
    );
    run(`
      savedFrames = {}
      local save = C_AddOns.SaveAddOns
      C_AddOns.SaveAddOns = function()
        save()
        local bytes = {}
        for byte = 0, 95 do
          local value = 0
          for position = 0, 7 do
            if states[string.format('WispAI_S%04d', 257 + byte*8 + position)] then
              value = value + 2^position
            end
          end
          bytes[#bytes+1] = string.char(value)
        end
        savedFrames[#savedFrames+1] = table.concat(bytes)
      end
      assert(ns.Transport.StartTransport())
      local packet = { type = 'state_result', chat = 'chat', requestId = 'max-rewards', data = observation }
      ns.Transport.Send(packet)
      for i = 1, 1024 do
        if not packet.queued then break end
        now = now + .04
        timers[.04]()
      end
      assert(not packet.queued, 'bounded maximum fixture must finish sending')
    `);
    const frames: Buffer[] = [];
    lua.lua_getglobal(state, to_luastring('savedFrames'));
    for (let i = 1; i <= lua.lua_rawlen(state, -1); i++) {
      lua.lua_rawgeti(state, -1, i);
      frames.push(Buffer.from(lua.lua_tolstring(state, -1)));
      lua.lua_pop(state, 1);
    }
    lua.lua_pop(state, 1);
    return { observation, frames, serializedBytes, compressedBytes };
  } finally {
    lua.lua_close(state);
  }
}
