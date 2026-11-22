import type { Row } from './csv.ts';

export interface MapPoint {
  mapId: number;
  x: number;
  y: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

// Converts a world position on a continent (Map.db2 ID) to a UI map's 0-100
// frame using that map's UiMapAssignment bounds. World X runs north and world
// Y runs west, so map x follows -Y and map y follows -X. Returns null when the
// position lies outside the UI map. Neighbouring zones' bounds overlap, so
// callers name the UI map instead of searching for one.
export function mapPosition(
  assignments: Row[],
  uiMapId: number,
  continentId: number,
  worldX: number,
  worldY: number,
): MapPoint | null {
  const region = assignments.find(
    (row) =>
      Number(row.UiMapID) === uiMapId &&
      Number(row.MapID) === continentId &&
      worldX >= Number(row.Region_0) &&
      worldX <= Number(row.Region_3) &&
      worldY >= Number(row.Region_1) &&
      worldY <= Number(row.Region_4),
  );
  if (!region) {
    return null;
  }
  const [minX, minY, maxX, maxY] = ['Region_0', 'Region_1', 'Region_3', 'Region_4'].map((k) =>
    Number(region[k]),
  ) as [number, number, number, number];
  const [uiMinX, uiMinY, uiMaxX, uiMaxY] = ['UiMin_0', 'UiMin_1', 'UiMax_0', 'UiMax_1'].map((k) =>
    Number(region[k]),
  ) as [number, number, number, number];
  const u = uiMinX + ((maxY - worldY) / (maxY - minY)) * (uiMaxX - uiMinX);
  const v = uiMinY + ((maxX - worldX) / (maxX - minX)) * (uiMaxY - uiMinY);
  return { mapId: uiMapId, x: round(u * 100), y: round(v * 100) };
}
