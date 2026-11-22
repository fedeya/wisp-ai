import { readFile } from 'node:fs/promises';
import { zonesAt } from '../coordinates.ts';
import type { Curated, Dataset } from '../dataset.ts';
import type { LuaTable } from '../lua.ts';
import { num, str } from '../rows.ts';

type Point = [mapId: number, x: number, y: number];
export interface EntranceCuration {
  // Instance map ID -> the zone(s) to draw its entrance on, only where more
  // than one zone's bounds contain it; generation lists the candidates.
  zones: Record<string, number[]>;
  // Instance map ID -> entrance, for instances Map.db2 gives no position.
  entrances: Record<string, Curated<Point>>;
  // Instance map ID -> why it is left out (unused or test maps).
  skip: Record<string, string>;
}

const INSTANCE = new Set(['1', '2']); // Map.InstanceType: dungeon, raid

export async function readCuration(): Promise<EntranceCuration> {
  return JSON.parse(
    await readFile(new URL('../../curated/dungeon-entrances.json', import.meta.url), 'utf8'),
  );
}

// Dungeon and raid entrances: Map.db2's Corpse position (where a ghost
// returns, the entrance) on the zone map that contains it, plus curated points
// for instances whose Map row has none. Instances without either are left out.
export function dungeonEntrances(curation?: EntranceCuration): Dataset {
  return {
    name: 'dungeon-entrances',
    description: 'Instance map ID -> name, raid, players, entrances as { UI map ID, x, y }.',
    tables: ['Map', 'UiMap', 'UiMapAssignment'],
    output: {
      format: 'lua',
      path: 'addon/WispAI/Data/DungeonEntrances.lua',
      name: 'DungeonEntrances',
    },
    async build(tables) {
      const { zones, entrances, skip } = curation ?? (await readCuration());
      const [maps, uiMaps, assignments] = await Promise.all([
        tables.read('Map'),
        tables.read('UiMap'),
        tables.read('UiMapAssignment'),
      ]);
      const value: LuaTable = {};
      const used = new Set<string>();
      const problems: string[] = [];
      for (const map of maps) {
        const id = str(map, 'ID');
        if (!INSTANCE.has(str(map, 'InstanceType')) || skip[id]) {
          continue;
        }
        const points: Point[] = [];
        const continent = num(map, 'CorpseMapID');
        const [worldX, worldY] = [num(map, 'Corpse_0'), num(map, 'Corpse_1')];
        if (continent >= 0 && (worldX !== 0 || worldY !== 0)) {
          const candidates = zonesAt(assignments, uiMaps, continent, worldX, worldY);
          const chosen = zones[id];
          if (chosen) {
            used.add(id);
            if (candidates.length === 1) {
              problems.push(
                `${str(map, 'MapName_lang')} (${id}): only one zone contains its entrance; remove it from the curated zones`,
              );
            }
            for (const zone of chosen) {
              const match = candidates.find((candidate) => candidate.mapId === zone);
              if (!match) {
                problems.push(
                  `${str(map, 'MapName_lang')} (${id}): zone ${zone} does not contain its entrance`,
                );
              } else {
                points.push([match.mapId, match.x, match.y]);
              }
            }
          } else if (candidates.length === 1) {
            points.push([candidates[0]!.mapId, candidates[0]!.x, candidates[0]!.y]);
          } else if (candidates.length > 1) {
            problems.push(
              `${str(map, 'MapName_lang')} (${id}): choose its zone in curated/dungeon-entrances.json from ` +
                candidates
                  .map(
                    (candidate) =>
                      `${candidate.mapId} ${candidate.name} ${candidate.x}, ${candidate.y}`,
                  )
                  .join('; '),
            );
          }
        }
        const curated = entrances[id];
        if (curated) {
          used.add(id);
          points.push(curated.value);
        }
        if (!points.length) {
          continue;
        }
        const raid = str(map, 'InstanceType') === '2';
        value[id] = {
          name: str(map, 'MapName_lang'),
          raid,
          players: raid ? num(map, 'MaxPlayers') : undefined,
          entrances: points,
        };
      }
      for (const id of [...Object.keys(zones), ...Object.keys(entrances), ...Object.keys(skip)]) {
        if (skip[id] && maps.some((map) => str(map, 'ID') === id)) {
          continue;
        }
        if (!used.has(id)) {
          problems.push(`Curated instance ${id} is not an instance with an entrance in Map.db2`);
        }
      }
      if (problems.length) {
        throw new Error(problems.join('\n'));
      }
      return value;
    },
  };
}
