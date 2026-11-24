import type { AtlasLootData } from '../atlasloot.ts';
import { readFile } from 'node:fs/promises';
import type { Curated, Dataset } from '../dataset.ts';
import type { LuaTable } from '../lua.ts';
import { num, str } from '../rows.ts';

type LuaRecord = Record<string, unknown>;

// AtlasLoot's difficulties in the order a boss's list is read: dungeons use
// NORMAL, raids their size, and a few lists split by faction.
const DIFFICULTIES = ['NORMAL', '40RAID', '20RAID', 'horde', 'alliance'];
const INSTANCE_TYPES = new Set(['1', '2']); // Map.InstanceType: dungeon, raid
// AtlasLoot pages hold 30 slots in two columns of 15; a header names the
// items below it in its own column.
const COLUMN = 15;
const NO_DROPS = / - No drops discovered yet$/;

function record(value: unknown): LuaRecord {
  return value && typeof value === 'object' ? (value as LuaRecord) : {};
}
// Lua arrays arrive as objects keyed "1", "2", ...
function list(value: unknown): unknown[] {
  return Object.entries(record(value))
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, entry]) => entry);
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

export interface LootItem {
  id: number;
  chance?: number;
  forever?: true;
}
export interface LootBoss {
  name: string;
  npcIds?: number[];
  extra?: true;
  noDropsYet?: true;
  items: LootItem[];
}
export interface LootInstance {
  key: string;
  name: string;
  instanceMapId?: number;
  kind: 'dungeon' | 'raid' | 'world';
  forever?: true;
  levels?: { min: number; recommended: number; max: number };
  bosses: LootBoss[];
}

// The items of one boss list for its first difficulty that has any, with the
// "Forever" header marking what Forever added to a classic boss.
function bossItems(
  boss: LuaRecord,
  npcIds: number[],
  rates: AtlasLootData['droprates'],
): LootItem[] {
  let entries: unknown[] = [];
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
    } else if (Number.isInteger(value) && (value as number) > 0 && !seen.has(value as number)) {
      const id = value as number;
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

export interface LootCuration {
  // AtlasLoot table key -> instance map ID where its name matches none in
  // Map.db2; null for an instance the pinned build does not have yet.
  instanceMapIds: Record<string, Curated<number | null>>;
}

export async function readLootCuration(): Promise<LootCuration> {
  return JSON.parse(
    await readFile(new URL('../../curated/dungeon-loot.json', import.meta.url), 'utf8'),
  );
}

// Boss loot of every dungeon and raid as AtlasLoot Classic Forever lists it:
// who drops what, Forever's own instances and the drops Forever added to
// classic bosses, with AtlasLoot's per-NPC drop rates where it has them.
// readAtlasLoot runs the pinned release; Map names place Forever's instances,
// which AtlasLoot lists by name only.
export function dungeonLoot(
  readAtlasLoot: (areas: Map<number, string>) => Promise<AtlasLootData>,
  curation?: LootCuration,
): Dataset {
  return {
    name: 'dungeon-loot',
    description:
      'Dungeon and raid boss loot (instance -> bosses -> item IDs, Forever flag, drop %) from AtlasLoot Classic Forever.',
    tables: ['AreaTable', 'Map'],
    credits:
      'Loot facts from AtlasLoot Classic Forever by Sliccer (CurseForge project 1422985, GPL-2.0-or-later), release pinned in build.json.',
    output: { format: 'json', path: 'apps/bridge/src/integrations/dungeon-loot.json' },
    async build(tables) {
      const [areaRows, maps] = await Promise.all([tables.read('AreaTable'), tables.read('Map')]);
      const areas = new Map(areaRows.map((row) => [num(row, 'ID'), str(row, 'AreaName_lang')]));
      const instanceIds = new Map<string, number>();
      const mapNames = new Map<number, string>();
      for (const map of maps) {
        if (INSTANCE_TYPES.has(str(map, 'InstanceType'))) {
          instanceIds.set(fold(str(map, 'MapName_lang')), num(map, 'ID'));
          mapNames.set(num(map, 'ID'), str(map, 'MapName_lang'));
        }
      }
      const { instanceMapIds } = curation ?? (await readLootCuration());
      const atlas = await readAtlasLoot(areas);
      const instances: LootInstance[] = [];
      const unplaced: string[] = [];
      for (const [key, table] of Object.entries(atlas.tables).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const atlasName = plain(String(table.name ?? key));
        const content = String(table.ContentType ?? '');
        const kind = key === 'WorldBosses' ? 'world' : /raid/i.test(content) ? 'raid' : 'dungeon';
        const curated = instanceMapIds[key];
        const instanceMapId = Number.isInteger(table.InstanceID)
          ? (table.InstanceID as number)
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
          const npcIds = (
            Array.isArray(npc) ? npc : Number.isInteger(npc) ? [npc] : list(npc)
          ).filter((id): id is number => Number.isInteger(id));
          const bossName = String(boss.name ?? '');
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
          ...(max ? { levels: { min, recommended, max } } : {}),
          bosses,
        });
      }
      if (unplaced.length) {
        throw new Error(
          `No instance map matches these AtlasLoot tables; add them to curated/dungeon-loot.json: ${unplaced.join(', ')}`,
        );
      }
      return { instances } as unknown as LuaTable;
    },
  };
}
