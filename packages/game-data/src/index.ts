import { readFileSync } from 'node:fs';
import { type AtlasLootData, type AtlasLootPin, readAtlasLoot, runAtlasLoot } from './atlasloot.ts';
import type { Dataset } from './dataset.ts';
import { dungeonEntrances } from './datasets/dungeon-entrances.ts';
import { dungeonLoot } from './datasets/dungeon-loot.ts';
import { groupFinderNames } from './datasets/group-finder-names.ts';

export { parseCsv, type Row } from './csv.ts';
export { mapPosition, zonesAt, type MapPoint } from './coordinates.ts';
export { render, type Curated, type Dataset, type Output } from './dataset.ts';
export { luaModule, luaString, luaValue, type LuaTable, type LuaValue } from './lua.ts';
export { byId, num, str } from './rows.ts';
export { latestBuild, memoryTables, wagoTables, type Locale, type TableSource } from './wago.ts';

export { atlasLootUrl, type AtlasLootData, type AtlasLootPin } from './atlasloot.ts';
export { unzip } from './zip.ts';

// The Forever build every dataset is generated from; product is wago.tools'
// name for it ("wowf"); atlasloot pins the loot tables' release.
export const pinned: { product: string; build: string; atlasloot: AtlasLootPin } = JSON.parse(
  readFileSync(new URL('../build.json', import.meta.url), 'utf8'),
);

// Where datasets read sources other than the game tables.
export interface DatasetSources {
  atlasLoot(areas: Map<number, string>): Promise<AtlasLootData>;
}

export function pinnedSources(cacheDir: string, refresh = false): DatasetSources {
  return {
    async atlasLoot(areas) {
      return runAtlasLoot(await readAtlasLoot(pinned.atlasloot, cacheDir, refresh), areas);
    },
  };
}

export function datasets(sources?: DatasetSources): Dataset[] {
  const loot = (areas: Map<number, string>) => {
    if (!sources) {
      throw new Error('dungeon-loot needs the AtlasLoot source');
    }
    return sources.atlasLoot(areas);
  };
  return [dungeonEntrances(), dungeonLoot(loot), groupFinderNames()];
}
