import { readFileSync } from 'node:fs';
import type { Dataset } from './dataset.ts';
import { dungeonEntrances } from './datasets/dungeon-entrances.ts';

export { parseCsv, type Row } from './csv.ts';
export { mapPosition, type MapPoint } from './coordinates.ts';
export { luaModule, luaString, luaValue, type LuaTable, type LuaValue } from './lua.ts';
export { memoryTables, wagoTables, type TableSource } from './wago.ts';
export type { Curated, Dataset } from './dataset.ts';

// The Forever build every dataset is generated from.
export const pinned: { product: string; build: string } = JSON.parse(
  readFileSync(new URL('../build.json', import.meta.url), 'utf8'),
);

export function datasets(): Dataset[] {
  return [dungeonEntrances()];
}
