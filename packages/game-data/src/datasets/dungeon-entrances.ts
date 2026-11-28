// @effect-migrated
import { Effect, Schema } from 'effect';
import type { FileSystem, Path } from 'effect';
import { UiMapAssignmentRow, UiMapRow, zonesAt } from '../coordinates.ts';
import { Curated, DatasetError, readPackageJson, type Dataset } from '../dataset.ts';
import type { LuaTable } from '../lua.ts';
import { GameTables } from '../wago.ts';

// An entrance: UI map ID, x, y.
const Point = Schema.Tuple([Schema.Int, Schema.Finite, Schema.Finite]);
type Point = typeof Point.Type;
const EntranceCuration = Schema.Struct({
  // Instance map ID -> the zone(s) to draw its entrance on, only where more
  // than one zone's bounds contain it; generation lists the candidates.
  zones: Schema.Record(Schema.String, Schema.Array(Schema.Int)),
  // Instance map ID -> entrance, for instances Map.db2 gives no position.
  entrances: Schema.Record(Schema.String, Curated(Point)),
  // Instance map ID -> why it is left out (unused or test maps).
  skip: Schema.Record(Schema.String, Schema.String),
});
export type EntranceCuration = typeof EntranceCuration.Type;

// Map.db2's columns this dataset reads: Corpse_0/Corpse_1 on CorpseMapID's
// continent is where a ghost returns, the entrance.
const MapRow = Schema.Struct({
  ID: Schema.Int,
  MapName_lang: Schema.String,
  InstanceType: Schema.Int,
  CorpseMapID: Schema.Int,
  Corpse_0: Schema.Finite,
  Corpse_1: Schema.Finite,
  MaxPlayers: Schema.Int,
});
type MapRow = typeof MapRow.Type;

const DUNGEON = 1; // Map.InstanceType
const RAID = 2;

export const readCuration: Effect.Effect<
  EntranceCuration,
  DatasetError,
  FileSystem.FileSystem | Path.Path
> = readPackageJson('curated/dungeon-entrances.json', EntranceCuration);

// Each instance's entrances, and what the curation must fix before they can be written.
function placeEntrances(
  { zones, entrances, skip }: EntranceCuration,
  maps: readonly MapRow[],
  uiMaps: readonly UiMapRow[],
  assignments: readonly UiMapAssignmentRow[],
): { value: LuaTable; problems: string[] } {
  const value: LuaTable = {};
  const used = new Set<string>();
  const problems: string[] = [];
  for (const map of maps) {
    const id = String(map.ID);
    const name = map.MapName_lang;
    if ((map.InstanceType !== DUNGEON && map.InstanceType !== RAID) || skip[id]) {
      continue;
    }
    const points: Point[] = [];
    const { CorpseMapID: continent, Corpse_0: worldX, Corpse_1: worldY } = map;
    if (continent >= 0 && (worldX !== 0 || worldY !== 0)) {
      const candidates = zonesAt(assignments, uiMaps, continent, worldX, worldY);
      const [only] = candidates;
      const chosen = zones[id];
      if (chosen) {
        used.add(id);
        if (candidates.length === 1) {
          problems.push(
            `${name} (${id}): only one zone contains its entrance; remove it from the curated zones`,
          );
        }
        for (const zone of chosen) {
          const match = candidates.find((candidate) => candidate.mapId === zone);
          if (!match) {
            problems.push(`${name} (${id}): zone ${zone} does not contain its entrance`);
          } else {
            points.push([match.mapId, match.x, match.y]);
          }
        }
      } else if (only && candidates.length === 1) {
        points.push([only.mapId, only.x, only.y]);
      } else if (candidates.length > 1) {
        problems.push(
          `${name} (${id}): choose its zone in curated/dungeon-entrances.json from ` +
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
    const raid = map.InstanceType === RAID;
    value[id] = {
      name,
      raid,
      players: raid ? map.MaxPlayers : undefined,
      entrances: points,
    };
  }
  for (const id of [...Object.keys(zones), ...Object.keys(entrances), ...Object.keys(skip)]) {
    if (skip[id] && maps.some((map) => String(map.ID) === id)) {
      continue;
    }
    if (!used.has(id)) {
      problems.push(`Curated instance ${id} is not an instance with an entrance in Map.db2`);
    }
  }
  return { value, problems };
}

// Dungeon and raid entrances: Map.db2's Corpse position (where a ghost
// returns, the entrance) on the zone map that contains it, plus curated points
// for instances whose Map row has none. Instances without either are left out.
export function dungeonEntrances(
  curation?: EntranceCuration,
): Dataset<GameTables | FileSystem.FileSystem | Path.Path> {
  return {
    name: 'dungeon-entrances',
    description: 'Instance map ID -> name, raid, players, entrances as { UI map ID, x, y }.',
    tables: ['Map', 'UiMap', 'UiMapAssignment'],
    output: {
      format: 'lua',
      path: 'addon/WispAI/Data/DungeonEntrances.lua',
      name: 'DungeonEntrances',
    },
    build: Effect.gen(function* () {
      const tables = yield* GameTables;
      const chosen = curation ?? (yield* readCuration);
      const [maps, uiMaps, assignments] = yield* Effect.all(
        [
          tables.read('Map', MapRow),
          tables.read('UiMap', UiMapRow),
          tables.read('UiMapAssignment', UiMapAssignmentRow),
        ],
        { concurrency: 'unbounded' },
      );
      const { value, problems } = placeEntrances(chosen, maps, uiMaps, assignments);
      if (problems.length) {
        return yield* new DatasetError({ message: problems.join('\n') });
      }
      return value;
    }),
  };
}
