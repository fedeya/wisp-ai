// @effect-migrated
import { Effect, Schema } from 'effect';
import type { FileSystem, Path } from 'effect';
import { AtlasLoot, type AtlasLootData, type LuaJson, type LuaObject } from '../atlasloot.ts';
import { Curated, DatasetError, readPackageJson, type Dataset } from '../dataset.ts';
import { GameTables } from '../wago.ts';

// AtlasLoot's difficulties in the order a boss's list is read: dungeons use
// NORMAL, raids their size, and a few lists split by faction.
const DIFFICULTIES = ['NORMAL', '40RAID', '20RAID', 'horde', 'alliance'];
const INSTANCE_TYPES = new Set([1, 2]); // Map.InstanceType: dungeon, raid
// The columns this dataset reads from AreaTable.db2 and Map.db2.
const AreaRow = Schema.Struct({ ID: Schema.Int, AreaName_lang: Schema.String });
const MapRow = Schema.Struct({
  ID: Schema.Int,
  MapName_lang: Schema.String,
  InstanceType: Schema.Int,
});
type MapRow = typeof MapRow.Type;
// AtlasLoot pages hold 30 slots in two columns of 15; a header names the
// items below it in its own column.
const COLUMN = 15;
const NO_DROPS = / - No drops discovered yet$/;

function record(value: LuaJson | undefined): LuaObject {
  return value && typeof value === 'object' ? value : {};
}
// Lua arrays arrive as objects keyed "1", "2", ...
function list(value: LuaJson | undefined): LuaJson[] {
  return Object.entries(record(value))
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, entry]) => entry);
}
// A Lua string or number as text; anything else (nil, a table) reads as fallback.
function text(value: LuaJson | undefined, fallback: string): string {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : fallback;
}
// Instance names carry WoW color and texture escapes (AtlasLoot's "new" icon).
function plain(text: string) {
  return text
    .replace(/\|T.*?\|t/g, '')
    .replace(/\|c[0-9a-fA-F]{8}|\|r/g, '')
    .trim();
}
// A single camel-cased word: an AtlasLoot locale key, not a display name.
const LOCALE_KEY = /^[^\s]*[a-z][A-Z][^\s]*$/;
function fold(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^the /, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The generated file's shape. The types are aliases of the schemas' types, not
// interfaces, so the dataset's value is a LuaValue without a cast.
const LootItem = Schema.Struct({
  id: Schema.Int,
  chance: Schema.optionalKey(Schema.Finite),
  forever: Schema.optionalKey(Schema.Literal(true)),
});
export type LootItem = typeof LootItem.Type;
const LootBoss = Schema.Struct({
  name: Schema.String,
  npcIds: Schema.optionalKey(Schema.Array(Schema.Int)),
  extra: Schema.optionalKey(Schema.Literal(true)),
  noDropsYet: Schema.optionalKey(Schema.Literal(true)),
  items: Schema.Array(LootItem),
});
export type LootBoss = typeof LootBoss.Type;
const LootInstance = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  instanceMapId: Schema.optionalKey(Schema.Int),
  kind: Schema.Literals(['dungeon', 'raid', 'world']),
  forever: Schema.optionalKey(Schema.Literal(true)),
  levels: Schema.optionalKey(
    Schema.Struct({ min: Schema.Finite, recommended: Schema.Finite, max: Schema.Finite }),
  ),
  bosses: Schema.Array(LootBoss),
});
export type LootInstance = typeof LootInstance.Type;
export const DungeonLoot = Schema.Struct({ instances: Schema.Array(LootInstance) });
export type DungeonLoot = typeof DungeonLoot.Type;

// The items of one boss list for its first difficulty that has any, with the
// "Forever" header marking what Forever added to a classic boss.
function bossItems(
  boss: LuaObject,
  npcIds: number[],
  rates: AtlasLootData['droprates'],
): LootItem[] {
  let entries: LuaJson[] = [];
  for (const difficulty of DIFFICULTIES) {
    const table = record(boss[difficulty]);
    const from = table.GetItemsFromDiff;
    entries = [...list(typeof from === 'string' ? boss[from] : undefined), ...list(table)];
    if (entries.length) {
      break;
    }
  }
  const headers = new Map<number, string>();
  const items: LootItem[] = [];
  const seen = new Set<number>();
  // An entry is { slot, item ID | icon, nil, header label, ... }; keep the
  // Lua positions, since list() would close the nil gap.
  for (const entry of entries.map(record).sort((a, b) => Number(a['1']) - Number(b['1']))) {
    const [slot, value, label] = [entry['1'], entry['2'], entry['4']];
    const column = Math.floor((Number(slot) - 1) / COLUMN);
    if (typeof value === 'string' && /^INV_/i.test(value)) {
      headers.set(column, typeof label === 'string' ? label : '');
    } else if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value > 0 &&
      !seen.has(value)
    ) {
      const id = value;
      seen.add(id);
      const chance = Math.max(0, ...npcIds.map((npc) => rates[String(npc)]?.[String(id)] ?? 0));
      items.push({
        id,
        ...(chance > 0 ? { chance } : {}),
        ...(headers.get(column) === 'Forever' ? { forever: true as const } : {}),
      });
    }
  }
  return items;
}

const LootCuration = Schema.Struct({
  // AtlasLoot table key -> instance map ID where its name matches none in
  // Map.db2; null for an instance the pinned build does not have yet.
  instanceMapIds: Schema.Record(Schema.String, Curated(Schema.NullOr(Schema.Int))),
});
export type LootCuration = typeof LootCuration.Type;

export const readLootCuration: Effect.Effect<
  LootCuration,
  DatasetError,
  FileSystem.FileSystem | Path.Path
> = readPackageJson('curated/dungeon-loot.json', LootCuration);

// Map.db2's dungeons and raids by folded name, and their names by ID.
function instanceMaps(maps: readonly MapRow[]) {
  const instanceIds = new Map<string, number>();
  const mapNames = new Map<number, string>();
  for (const map of maps) {
    if (INSTANCE_TYPES.has(map.InstanceType)) {
      instanceIds.set(fold(map.MapName_lang), map.ID);
      mapNames.set(map.ID, map.MapName_lang);
    }
  }
  return { instanceIds, mapNames };
}

// Every AtlasLoot table as an instance with its bosses' loot, and the tables
// no instance map matches.
function lootInstances(
  atlas: AtlasLootData,
  { instanceIds, mapNames }: ReturnType<typeof instanceMaps>,
  instanceMapIds: LootCuration['instanceMapIds'],
) {
  const instances: LootInstance[] = [];
  const unplaced: string[] = [];
  for (const [key, table] of Object.entries(atlas.tables).sort(([a], [b]) => a.localeCompare(b))) {
    const atlasName = plain(text(table.name, key));
    const content = text(table.ContentType, '');
    const kind = key === 'WorldBosses' ? 'world' : /raid/i.test(content) ? 'raid' : 'dungeon';
    const curated = instanceMapIds[key];
    const instanceId = table.InstanceID;
    const instanceMapId =
      typeof instanceId === 'number' && Number.isInteger(instanceId)
        ? instanceId
        : (instanceIds.get(fold(atlasName)) ?? curated?.value ?? undefined);
    // Some classic tables are named by an AtlasLoot locale key such as
    // "MoltenCore", which the stubbed locale returns as is; the game's
    // Map name is the real one.
    const name =
      LOCALE_KEY.test(atlasName) && instanceMapId !== undefined
        ? (mapNames.get(instanceMapId) ?? atlasName)
        : atlasName;
    if (kind !== 'world' && instanceMapId === undefined && !curated) {
      unplaced.push(`${key} (${name})`);
    }
    const [min, recommended, max] = list(table.LevelRange).map(Number);
    const bosses: LootBoss[] = [];
    for (const boss of list(table.items).map(record)) {
      if (boss.IgnoreAsSource || boss.TableType === 'Set') {
        continue;
      }
      const npc = boss.npcID;
      // One NPC ID, or a list of them; WISP_RESULT writes no JSON arrays.
      const npcIds = (Number.isInteger(npc) ? [npc] : list(npc)).filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id),
      );
      const bossName = text(boss.name, '');
      const items = bossItems(boss, npcIds, atlas.droprates);
      if (!items.length && !NO_DROPS.test(bossName)) {
        continue;
      }
      bosses.push({
        name: bossName.replace(NO_DROPS, ''),
        ...(npcIds.length ? { npcIds } : {}),
        ...(boss.ExtraList ? { extra: true as const } : {}),
        ...(NO_DROPS.test(bossName) ? { noDropsYet: true as const } : {}),
        items,
      });
    }
    instances.push({
      key,
      name,
      ...(instanceMapId !== undefined ? { instanceMapId } : {}),
      kind,
      ...(content.startsWith('Forever') ? { forever: true as const } : {}),
      // `list` is dense, so a range with a maximum also has its first two levels.
      ...(min !== undefined && recommended !== undefined && max
        ? { levels: { min, recommended, max } }
        : {}),
      bosses,
    });
  }
  return { instances, unplaced };
}

// Boss loot of every dungeon and raid as AtlasLoot Classic Forever lists it:
// who drops what, Forever's own instances and the drops Forever added to
// classic bosses, with AtlasLoot's per-NPC drop rates where it has them.
// AtlasLoot runs the pinned release; Map names place Forever's instances,
// which AtlasLoot lists by name only.
export function dungeonLoot(
  curation?: LootCuration,
): Dataset<GameTables | AtlasLoot | FileSystem.FileSystem | Path.Path> {
  return {
    name: 'dungeon-loot',
    description:
      'Dungeon and raid boss loot (instance -> bosses -> item IDs, Forever flag, drop %) from AtlasLoot Classic Forever.',
    tables: ['AreaTable', 'Map'],
    credits:
      'Loot facts from AtlasLoot Classic Forever by Sliccer (CurseForge project 1422985, GPL-2.0-or-later), release pinned in build.json.',
    output: { format: 'json', path: 'apps/agent/src/wisp/dungeon-loot.json' },
    build: Effect.gen(function* () {
      const tables = yield* GameTables;
      const [areaRows, maps] = yield* Effect.all(
        [tables.read('AreaTable', AreaRow), tables.read('Map', MapRow)],
        { concurrency: 'unbounded' },
      );
      const areas = new Map(areaRows.map((row) => [row.ID, row.AreaName_lang]));
      const instances = instanceMaps(maps);
      const { instanceMapIds } = curation ?? (yield* readLootCuration);
      const atlas = yield* AtlasLoot.use((source) => source.load(areas));
      const loot = lootInstances(atlas, instances, instanceMapIds);
      if (loot.unplaced.length) {
        return yield* new DatasetError({
          message: `No instance map matches these AtlasLoot tables; add them to curated/dungeon-loot.json: ${loot.unplaced.join(', ')}`,
        });
      }
      const value: DungeonLoot = { instances: loot.instances };
      return value;
    }),
  };
}
