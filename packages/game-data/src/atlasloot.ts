import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { unzip } from './zip.ts';

// The pinned AtlasLoot Classic Forever release (CurseForge project 1422985,
// GPL-2.0-or-later): curated boss loot for Forever's dungeons and raids,
// including Forever's own instances and the drops Forever added to classic
// bosses, plus per-NPC drop rates. Wisp keeps facts only (IDs, names, levels,
// rates), not AtlasLoot's code. Bump file, name and sha256 together.
export interface AtlasLootPin {
  project: number;
  file: number;
  name: string;
  sha256: string;
}

export function atlasLootUrl(pin: AtlasLootPin) {
  const id = String(pin.file);
  return `https://mediafilez.forgecdn.net/files/${id.slice(0, -3)}/${Number(id.slice(-3))}/${pin.name}`;
}

// Downloads the pinned archive once into cacheDir and checks its hash.
export async function readAtlasLoot(
  pin: AtlasLootPin,
  cacheDir: string,
  refresh = false,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, Buffer>> {
  const file = path.join(cacheDir, 'atlasloot', pin.name);
  let archive: Buffer | undefined;
  if (!refresh) {
    archive = await readFile(file).catch(() => undefined);
  }
  if (!archive) {
    const response = await fetcher(atlasLootUrl(pin), { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`AtlasLoot ${pin.name}: HTTP ${response.status}`);
    }
    archive = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, archive);
  }
  const hash = createHash('sha256').update(archive).digest('hex');
  if (hash !== pin.sha256) {
    throw new Error(`AtlasLoot ${pin.name}: sha256 ${hash} does not match the pin ${pin.sha256}`);
  }
  return unzip(archive);
}

// What running AtlasLoot's loot modules leaves behind: each loot table by
// key (tables keyed by Lua's own keys, as strings) and drop rates
// (npc ID -> item ID -> percent).
export interface AtlasLootData {
  tables: Record<string, Record<string, unknown>>;
  droprates: Record<string, Record<string, number>>;
}

// Stubs for the WoW and AtlasLoot APIs the data files call while loading, as
// a Classic-family client with every content phase out. Anything else they
// touch (frames, the GUI hooks at the end of data.lua) is an inert stub.
const PRELUDE = `
local inert
inert = setmetatable({}, {
  __index = function() return inert end,
  __call = function() return inert end,
  __concat = function(a, b) return (type(a) == "string" and a or "") .. (type(b) == "string" and b or "") end,
})
getfenv = function() return _G end
unpack = table.unpack
hooksecurefunc = function() end
CreateFrame = function() return inert end
UnitFactionGroup = function() return "Horde" end
FACTION_HORDE, FACTION_ALLIANCE = "Horde", "Alliance"
C_Map = { GetAreaInfo = function(id) return WISP_AREAS[id] or ("Area " .. id) end }
local captured, droprates = {}, {}
local methods = {
  AddDifficulty = function(_, name, key) return key or name end,
  AddContentType = function(_, name) return name end,
  AddItemTableType = function(_, name) return name end,
  AddExtraItemTableType = function(_, name) return name end,
}
AtlasLoot = {
  CLASSIC_VERSION_NUM = 1, BC_VERSION_NUM = 2, WRATH_VERSION_NUM = 3,
  Locales = setmetatable({}, { __index = function(_, key) return key end }),
  ReturnForGameVersion = function(classic) return classic end,
  GameVersion_GE = function(_, version, value) if version <= 1 then return value end end,
  GameVersion_LT = function(_, version, value, other) if 1 < version then return value end return other end,
  GameVersion_EQ = function(_, version, value) if version == 1 then return value == nil or value end end,
  ItemDB = { Add = function() return setmetatable(captured, { __index = methods }) end },
  Data = {
    ContentPhase = { GetActivePhase = function() return 99 end },
    Droprate = { AddData = function(_, rates) droprates = rates end },
  },
  GUI = inert,
}
setmetatable(_G, { __index = function() return inert end })

local function encode(value, out)
  local kind = type(value)
  if kind == "table" then
    out[#out + 1] = "{"
    local first = true
    for key, entry in pairs(value) do
      if type(entry) ~= "function" and entry ~= inert and type(key) ~= "table" then
        if not first then out[#out + 1] = "," end
        first = false
        encode(tostring(key), out)
        out[#out + 1] = ":"
        encode(entry, out)
      end
    end
    out[#out + 1] = "}"
  elseif kind == "string" then
    out[#out + 1] = '"' .. value:gsub('[%c"\\\\]', function(c) return string.format("\\\\u%04x", c:byte()) end) .. '"'
  elseif kind == "number" then
    out[#out + 1] = (value ~= value or value == math.huge or value == -math.huge) and "null" or string.format("%.17g", value)
  elseif kind == "boolean" then
    out[#out + 1] = tostring(value)
  else
    out[#out + 1] = "null"
  end
end
function WISP_RESULT()
  local out = {}
  encode({ tables = captured, droprates = droprates }, out)
  return table.concat(out)
end
`;

// Runs the Forever TOC's loot files (data.lua and droprate.lua) of the
// Dungeons and Raids module in a Lua VM. areas names AreaTable IDs, which
// data.lua resolves through C_Map.GetAreaInfo.
export function runAtlasLoot(
  files: Map<string, Buffer>,
  areas: Map<number, string>,
): AtlasLootData {
  const require = createRequire(import.meta.url);
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const check = (status: number, what: string) => {
    if (status !== lua.LUA_OK) {
      throw new Error(`${what}: ${to_jsstring(lua.lua_tolstring(L, -1))}`);
    }
  };
  lua.lua_createtable(L, 0, areas.size);
  for (const [id, name] of areas) {
    lua.lua_pushstring(L, to_luastring(name));
    lua.lua_rawseti(L, -2, id);
  }
  lua.lua_setglobal(L, to_luastring('WISP_AREAS'));
  check(lauxlib.luaL_loadstring(L, to_luastring(PRELUDE)), 'AtlasLoot prelude');
  check(lua.lua_pcall(L, 0, 0, 0), 'AtlasLoot prelude');
  const module = 'AtlasLootClassic_DungeonsAndRaids';
  for (const name of ['data.lua', 'droprate.lua']) {
    const source = files.get(`${module}/${name}`);
    if (!source) {
      throw new Error(`AtlasLoot archive has no ${module}/${name}`);
    }
    check(lauxlib.luaL_loadstring(L, to_luastring(source.toString('utf8'))), name);
    lua.lua_pushstring(L, to_luastring(module));
    check(lua.lua_pcall(L, 1, 0, 0), name);
  }
  lua.lua_getglobal(L, to_luastring('WISP_RESULT'));
  check(lua.lua_pcall(L, 0, 1, 0), 'AtlasLoot result');
  return JSON.parse(to_jsstring(lua.lua_tolstring(L, -1)));
}
