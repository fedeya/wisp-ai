import { readFileSync } from 'node:fs';
import type { Dataset } from './dataset.ts';
import { dungeonEntrances } from './datasets/dungeon-entrances.ts';
import { groupFinderNames } from './datasets/group-finder-names.ts';

export { parseCsv, type Row } from './csv.ts';
export { mapPosition, zonesAt, type MapPoint } from './coordinates.ts';
export { render, type Curated, type Dataset, type Output } from './dataset.ts';
export { luaModule, luaString, luaValue, type LuaTable, type LuaValue } from './lua.ts';
export { byId, num, str } from './rows.ts';
export { latestBuild, memoryTables, wagoTables, type Locale, type TableSource } from './wago.ts';

// The Forever build every dataset is generated from; product is wago.tools'
// name for it ("wowf").
export const pinned: { product: string; build: string } = JSON.parse(
  readFileSync(new URL('../build.json', import.meta.url), 'utf8'),
);

export function datasets(): Dataset[] {
  return [dungeonEntrances(), groupFinderNames()];
}
