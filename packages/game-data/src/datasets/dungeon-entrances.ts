import { readFile } from 'node:fs/promises';
import { mapPosition } from '../coordinates.ts';
import { generatedHeader, type Curated, type Dataset } from '../dataset.ts';
import { luaModule, type LuaTable } from '../lua.ts';

type Point = [mapId: number, x: number, y: number];
export interface EntranceCuration {
  zones: Record<string, number[]>;
  entrances: Record<string, Curated<Point>>;
}

const TABLES = ['Map', 'UiMapAssignment'];

export async function readCuration(): Promise<EntranceCuration> {
  return JSON.parse(
    await readFile(new URL('../../curated/dungeon-entrances.json', import.meta.url), 'utf8'),
  );
}

// Dungeon and raid entrances: Map.db2's Corpse position (where a ghost
// returns, the entrance) on each zone named in the curation, plus curated
// points for instances whose Map row has none.
export function dungeonEntrances(curation?: EntranceCuration): Dataset {
  const dataset: Dataset = {
    name: 'dungeon-entrances',
    description: 'Instance map ID -> name, raid, players, entrances as { UI map ID, x, y }.',
    output: 'addon/WispAI/Data/DungeonEntrances.lua',
    async generate(tables, build) {
      const { zones, entrances } = curation ?? (await readCuration());
      const maps = await tables.read('Map');
      const assignments = await tables.read('UiMapAssignment');
      const value: LuaTable = {};
      const wanted = new Set([...Object.keys(zones), ...Object.keys(entrances)]);
      for (const map of maps) {
        if (!wanted.has(map.ID!)) {
          continue;
        }
        wanted.delete(map.ID!);
        const points: Point[] = [];
        for (const uiMap of zones[map.ID!] ?? []) {
          const point = mapPosition(
            assignments,
            uiMap,
            Number(map.CorpseMapID),
            Number(map.Corpse_0),
            Number(map.Corpse_1),
          );
          if (!point) {
            throw new Error(`${map.MapName_lang} (${map.ID}): entrance is outside UI map ${uiMap}`);
          }
          points.push([point.mapId, point.x, point.y]);
        }
        const curated = entrances[map.ID!];
        if (curated) {
          points.push(curated.value);
        }
        const raid = map.InstanceType === '2';
        value[map.ID!] = {
          name: map.MapName_lang,
          raid,
          players: raid ? Number(map.MaxPlayers) : undefined,
          entrances: points,
        };
      }
      if (wanted.size) {
        throw new Error(`Instances missing from Map.db2: ${[...wanted].join(', ')}`);
      }
      return luaModule('DungeonEntrances', generatedHeader(dataset, build, TABLES), value);
    },
  };
  return dataset;
}
