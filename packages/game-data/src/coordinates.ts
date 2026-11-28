// @effect-migrated
import { Schema } from 'effect';

// The UiMapAssignment columns that place a UI map over a continent: its world
// bounds (Region_0/Region_1 the lowest world X/Y, Region_3/Region_4 the
// highest) and the part of the UI map's 0-1 frame they cover.
export const UiMapAssignmentRow = Schema.Struct({
  UiMapID: Schema.Int,
  MapID: Schema.Int,
  Region_0: Schema.Finite,
  Region_1: Schema.Finite,
  Region_3: Schema.Finite,
  Region_4: Schema.Finite,
  UiMin_0: Schema.Finite,
  UiMin_1: Schema.Finite,
  UiMax_0: Schema.Finite,
  UiMax_1: Schema.Finite,
});
export type UiMapAssignmentRow = typeof UiMapAssignmentRow.Type;

export const UiMapRow = Schema.Struct({
  ID: Schema.Int,
  Type: Schema.Int,
  Name_lang: Schema.String,
});
export type UiMapRow = typeof UiMapRow.Type;

export interface MapPoint {
  mapId: number;
  x: number;
  y: number;
}

const ZONE = 3; // UiMap.Type for a zone map
const round = (value: number) => Math.round(value * 10) / 10;

function project(
  region: UiMapAssignmentRow,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  const { Region_0: minX, Region_1: minY, Region_3: maxX, Region_4: maxY } = region;
  // World X runs north and world Y runs west: map x follows -Y, map y follows -X.
  const u = region.UiMin_0 + ((maxY - worldY) / (maxY - minY)) * (region.UiMax_0 - region.UiMin_0);
  const v = region.UiMin_1 + ((maxX - worldX) / (maxX - minX)) * (region.UiMax_1 - region.UiMin_1);
  return { x: round(u * 100), y: round(v * 100) };
}

function contains(
  region: UiMapAssignmentRow,
  continentId: number,
  worldX: number,
  worldY: number,
): boolean {
  return (
    region.MapID === continentId &&
    worldX >= region.Region_0 &&
    worldX <= region.Region_3 &&
    worldY >= region.Region_1 &&
    worldY <= region.Region_4
  );
}

// A world position on a continent (Map.db2 ID) in a given UI map's 0-100
// frame, or null when that UI map does not contain it.
export function mapPosition(
  assignments: readonly UiMapAssignmentRow[],
  uiMapId: number,
  continentId: number,
  worldX: number,
  worldY: number,
): MapPoint | null {
  const region = assignments.find(
    (row) => row.UiMapID === uiMapId && contains(row, continentId, worldX, worldY),
  );
  return region ? { mapId: uiMapId, ...project(region, worldX, worldY) } : null;
}

// Every zone map whose bounds contain a world position. Zone bounds are
// rectangles that overlap their neighbours, so more than one can match.
export function zonesAt(
  assignments: readonly UiMapAssignmentRow[],
  uiMaps: readonly UiMapRow[],
  continentId: number,
  worldX: number,
  worldY: number,
): Array<MapPoint & { name: string }> {
  const maps = new Map(uiMaps.map((map) => [map.ID, map]));
  const out: Array<MapPoint & { name: string }> = [];
  for (const region of assignments) {
    const map = maps.get(region.UiMapID);
    if (map && map.Type === ZONE && contains(region, continentId, worldX, worldY)) {
      out.push({ mapId: map.ID, name: map.Name_lang, ...project(region, worldX, worldY) });
    }
  }
  return out.sort((a, b) => a.mapId - b.mapId);
}
