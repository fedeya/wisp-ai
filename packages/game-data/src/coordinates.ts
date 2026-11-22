import type { Row } from './csv.ts';
import { byId, num, str } from './rows.ts';

export interface MapPoint {
  mapId: number;
  x: number;
  y: number;
}

const ZONE = 3; // UiMap.Type for a zone map
const round = (value: number) => Math.round(value * 10) / 10;

function project(region: Row, worldX: number, worldY: number): { x: number; y: number } {
  const minX = num(region, 'Region_0');
  const minY = num(region, 'Region_1');
  const maxX = num(region, 'Region_3');
  const maxY = num(region, 'Region_4');
  // World X runs north and world Y runs west: map x follows -Y, map y follows -X.
  const u =
    num(region, 'UiMin_0') +
    ((maxY - worldY) / (maxY - minY)) * (num(region, 'UiMax_0') - num(region, 'UiMin_0'));
  const v =
    num(region, 'UiMin_1') +
    ((maxX - worldX) / (maxX - minX)) * (num(region, 'UiMax_1') - num(region, 'UiMin_1'));
  return { x: round(u * 100), y: round(v * 100) };
}

function contains(region: Row, continentId: number, worldX: number, worldY: number): boolean {
  return (
    num(region, 'MapID') === continentId &&
    worldX >= num(region, 'Region_0') &&
    worldX <= num(region, 'Region_3') &&
    worldY >= num(region, 'Region_1') &&
    worldY <= num(region, 'Region_4')
  );
}

// A world position on a continent (Map.db2 ID) in a given UI map's 0-100
// frame, or null when that UI map does not contain it.
export function mapPosition(
  assignments: Row[],
  uiMapId: number,
  continentId: number,
  worldX: number,
  worldY: number,
): MapPoint | null {
  const region = assignments.find(
    (row) => num(row, 'UiMapID') === uiMapId && contains(row, continentId, worldX, worldY),
  );
  return region ? { mapId: uiMapId, ...project(region, worldX, worldY) } : null;
}

// Every zone map whose bounds contain a world position. Zone bounds are
// rectangles that overlap their neighbours, so more than one can match.
export function zonesAt(
  assignments: Row[],
  uiMaps: Row[],
  continentId: number,
  worldX: number,
  worldY: number,
): Array<MapPoint & { name: string }> {
  const maps = byId(uiMaps);
  const out: Array<MapPoint & { name: string }> = [];
  for (const region of assignments) {
    const map = maps.get(num(region, 'UiMapID'));
    if (map && num(map, 'Type') === ZONE && contains(region, continentId, worldX, worldY)) {
      out.push({
        mapId: num(map, 'ID'),
        name: str(map, 'Name_lang'),
        ...project(region, worldX, worldY),
      });
    }
  }
  return out.sort((a, b) => a.mapId - b.mapId);
}
