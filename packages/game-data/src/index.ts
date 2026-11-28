// @effect-migrated
import { Schema } from 'effect';
import type { Effect, FileSystem, Path } from 'effect';
import { AtlasLootPin, type AtlasLoot } from './atlasloot.ts';
import { readPackageJson, type Dataset, type DatasetError } from './dataset.ts';
import { dungeonEntrances } from './datasets/dungeon-entrances.ts';
import { dungeonLoot } from './datasets/dungeon-loot.ts';
import { groupFinderNames } from './datasets/group-finder-names.ts';
import { itemProficiencies } from './datasets/item-proficiencies.ts';
import type { GameTables } from './wago.ts';

export {
  mapPosition,
  UiMapAssignmentRow,
  UiMapRow,
  zonesAt,
  type MapPoint,
} from './coordinates.ts';
export {
  Curated,
  DatasetError,
  render,
  type Dataset,
  type DatasetFailure,
  type Output,
} from './dataset.ts';
export { luaModule, luaString, luaValue, type LuaTable, type LuaValue } from './lua.ts';
export {
  BuildListError,
  decodeTable,
  GameTables,
  TableReadError,
  latestBuild,
  type Locale,
  type RowSchema,
} from './wago.ts';

export {
  AtlasLoot,
  AtlasLootError,
  atlasLootUrl,
  type AtlasLootData,
  type AtlasLootPin,
} from './atlasloot.ts';
export { unzip } from './zip.ts';

// The Forever build every dataset is generated from; product is wago.tools'
// name for it ("wowf"); atlasloot pins the loot tables' release.
const Pinned = Schema.Struct({
  product: Schema.String,
  build: Schema.String,
  atlasloot: AtlasLootPin,
});
export type Pinned = typeof Pinned.Type;

export const readPinned: Effect.Effect<Pinned, DatasetError, FileSystem.FileSystem | Path.Path> =
  readPackageJson('build.json', Pinned);

// What building every dataset reads besides the game tables' rows.
export type DatasetSources = GameTables | AtlasLoot | FileSystem.FileSystem | Path.Path;

export const datasets: ReadonlyArray<Dataset<DatasetSources>> = [
  dungeonEntrances(),
  dungeonLoot(),
  groupFinderNames(),
  itemProficiencies(),
];
