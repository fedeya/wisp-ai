// Generates addon/WispAI/Character/DungeonEntrances.lua from Forever's game
// tables on wago.tools, so dungeon entrances ship with Wisp instead of coming
// from another addon. Run after a Forever patch:
//   node scripts/generate-dungeon-entrances.ts [build]
// Map.db2 gives each instance's entrance (where a ghost returns) in world
// coordinates; UiMapAssignment converts them to the zone map's 0-100 frame.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const build = process.argv[2] ?? '1.60.1.70888';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'addon/WispAI/Character/DungeonEntrances.lua');

// The zone map(s) each instance's entrance belongs to. World bounds of
// neighbouring zones overlap, so the zone is stated rather than guessed.
// Blackrock Mountain sits on both Searing Gorge and Burning Steppes.
const zones: Record<number, number[]> = {
  33: [1421], // Shadowfang Keep: Silverpine Forest
  34: [1453], // Stormwind Stockade: Stormwind City
  36: [1436], // Deadmines: Westfall
  43: [1413], // Wailing Caverns: The Barrens
  47: [1413], // Razorfen Kraul: The Barrens
  48: [1440], // Blackfathom Deeps: Ashenvale
  70: [1418], // Uldaman: Badlands
  90: [1426], // Gnomeregan: Dun Morogh
  109: [1435], // Sunken Temple: Swamp of Sorrows
  129: [1413], // Razorfen Downs: The Barrens
  189: [1420], // Scarlet Monastery: Tirisfal Glades
  209: [1446], // Zul'Farrak: Tanaris
  229: [1427, 1428], // Blackrock Spire
  230: [1427, 1428], // Blackrock Depths
  249: [1445], // Onyxia's Lair: Dustwallow Marsh
  289: [1422], // Scholomance: Western Plaguelands
  309: [1434], // Zul'Gurub: Stranglethorn Vale
  329: [1423], // Stratholme: Eastern Plaguelands
  349: [1443], // Maraudon: Desolace
  389: [1454], // Ragefire Chasm: Orgrimmar
  409: [1427, 1428], // Molten Core
  429: [1444], // Dire Maul: Feralas
  469: [1428], // Blackwing Lair: Burning Steppes
  509: [1451], // Ruins of Ahn'Qiraj: Silithus
  531: [1451], // Ahn'Qiraj Temple: Silithus
};

// Instances new in Forever have no entrance in Map.db2. These points come from
// OpenMap's Forever data (MIT, github.com/openmap-wow) and match QuestieDB
// Forever's dungeon table where it has them.
const curated: Record<number, [number, number, number]> = {
  2959: [1416, 8.5, 59.3], // City of Dalaran: Alterac Mountains
  2970: [1434, 21.3, 27.8], // The Drowned City: Stranglethorn Vale
  2974: [1447, 38.6, 33.2], // Blackmaw Hold: Azshara
  2994: [1445, 75.3, 14.1], // Alcaz Prison: Dustwallow Marsh
  2998: [1437, 47.8, 56.2], // Excavation Site: Wetlands
  2999: [1458, 72.5, 11.4], // Ruins of Lordaeron: Undercity
  3001: [1449, 48.1, 6.1], // The Shaper's Terrace: Un'Goro Crater
  3039: [2548, 37.5, 37.3], // Krol'dok Stronghold
  3065: [1455, 27.7, 47.9], // The Hall of Thanes: Ironforge
};

type Row = Record<string, string>;
async function table(name: string): Promise<Row[]> {
  const response = await fetch(`https://wago.tools/db2/${name}/csv?build=${build}`, {
    headers: { 'user-agent': 'wisp-dev-script' },
  });
  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status}`);
  }
  const [header, ...rows] = (await response.text())
    .trim()
    .split('\n')
    .map((line) => {
      const cells: string[] = [];
      let cell = '';
      let quoted = false;
      for (const char of line.replace(/\r$/, '')) {
        if (char === '"') {
          quoted = !quoted;
        } else if (char === ',' && !quoted) {
          cells.push(cell);
          cell = '';
        } else {
          cell += char;
        }
      }
      cells.push(cell);
      return cells;
    });
  return rows.map((row) => Object.fromEntries(header!.map((key, index) => [key, row[index]!])));
}

const round = (value: number) => Math.round(value * 10) / 10;
const maps = await table('Map');
const assignments = await table('UiMapAssignment');
const lines: string[] = [];
for (const map of maps) {
  const id = Number(map.ID);
  const raid = map.InstanceType === '2';
  const points: Array<[number, number, number]> = [];
  for (const uiMap of zones[id] ?? []) {
    const x = Number(map.Corpse_0);
    const y = Number(map.Corpse_1);
    const zone = assignments.find(
      (row) =>
        Number(row.UiMapID) === uiMap &&
        row.MapID === map.CorpseMapID &&
        x >= Number(row.Region_0) &&
        x <= Number(row.Region_3) &&
        y >= Number(row.Region_1) &&
        y <= Number(row.Region_4),
    );
    if (!zone) {
      throw new Error(`${map.MapName_lang}: entrance is outside UI map ${uiMap}`);
    }
    const u =
      Number(zone.UiMin_0) +
      ((Number(zone.Region_4) - y) / (Number(zone.Region_4) - Number(zone.Region_1))) *
        (Number(zone.UiMax_0) - Number(zone.UiMin_0));
    const v =
      Number(zone.UiMin_1) +
      ((Number(zone.Region_3) - x) / (Number(zone.Region_3) - Number(zone.Region_0))) *
        (Number(zone.UiMax_1) - Number(zone.UiMin_1));
    points.push([uiMap, round(u * 100), round(v * 100)]);
  }
  if (curated[id]) {
    points.push(curated[id]);
  }
  if (!points.length) {
    continue;
  }
  const entrances = points.map(([uiMap, x, y]) => `{ ${uiMap}, ${x}, ${y} }`).join(', ');
  const players = raid ? `, players = ${Number(map.MaxPlayers)}` : '';
  lines.push(
    `    [${id}] = { name = ${JSON.stringify(map.MapName_lang)}, raid = ${raid}${players}, entrances = { ${entrances} } },`,
  );
}
const missing = [...Object.keys(zones), ...Object.keys(curated)].filter(
  (id) => !lines.some((line) => line.startsWith(`    [${id}]`)),
);
if (missing.length) {
  throw new Error('Instances missing from Map.db2: ' + missing.join(', '));
}
await writeFile(
  output,
  [
    `-- Generated by scripts/generate-dungeon-entrances.ts from World of Warcraft: Forever`,
    `-- game tables (Map, UiMapAssignment) for build ${build} via wago.tools. Do not edit:`,
    `-- regenerate after a patch. Entrances are { UI map ID, x, y } in 0-100 map coordinates.`,
    `local _, ns = ...`,
    ``,
    `ns.Character.DungeonEntrancesBuild = ${JSON.stringify(build)}`,
    `ns.Character.DungeonEntrances = {`,
    ...lines,
    `}`,
    ``,
  ].join('\n'),
);
console.log(`Wrote ${lines.length} instances for build ${build} to ${path.relative(root, output)}`);
