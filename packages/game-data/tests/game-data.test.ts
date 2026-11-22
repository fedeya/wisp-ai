import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  datasets,
  luaModule,
  luaValue,
  mapPosition,
  memoryTables,
  num,
  parseCsv,
  pinned,
  render,
  str,
  zonesAt,
  type Dataset,
} from '../src/index.ts';
import { dungeonEntrances, type EntranceCuration } from '../src/datasets/dungeon-entrances.ts';

// Real rows from Forever 1.60.1.71037: Durotar, The Barrens and Orgrimmar.
const ASSIGNMENTS = parseCsv(
  [
    'UiMin_0,UiMin_1,UiMax_0,UiMax_1,Region_0,Region_1,Region_2,Region_3,Region_4,Region_5,ID,UiMapID,OrderIndex,MapID,AreaID',
    '0,0,1,1,-1716.6666259766,-7249.9995117188,-1000000,1808.3332519531,-1962.4998779297,1000000,46721,1411,0,1,14',
    '0,0,1,1,-5143.75,-7510.4165039062,-1000000,1612.4998779297,2622.9165039062,1000000,46723,1413,0,1,17',
    '0,0,1,1,1338.4605712891,-5083.2055664062,-1000000,2273.8771972656,-3680.6010742188,1000000,46764,1454,0,1,1637',
  ].join('\n'),
);
const UI_MAPS = parseCsv(
  'Name_lang,ID,ParentUiMapID,Flags,System,Type\nDurotar,1411,1414,2,0,3\n"The Barrens",1413,1414,2,0,3\nOrgrimmar,1454,1414,0,0,3\nKalimdor,1414,947,0,0,2',
);
// Map.db2 entrances on Kalimdor: Wailing Caverns lies inside both Durotar's
// and The Barrens' bounds; Ragefire Chasm only inside Orgrimmar's.
const WAILING = [-751.131, -2209.24] as const;
const RAGEFIRE = [1816.756, -4423.372] as const;

describe('csv and rows', () => {
  it('reads quoted cells, doubled quotes, commas and CRLF line ends', () => {
    expect(parseCsv('ID,Name,Note\r\n1,"Zul\'Farrak","a ""b"", c"\r\n2,Plain,\r\n')).toEqual([
      { ID: '1', Name: "Zul'Farrak", Note: 'a "b", c' },
      { ID: '2', Name: 'Plain', Note: '' },
    ]);
  });

  it('reads typed columns and fails on missing or non-numeric ones', () => {
    const [row] = parseCsv('ID,Level,Name\n7,abc,Orgrimmar');
    expect(num(row!, 'ID')).toBe(7);
    expect(str(row!, 'Name')).toBe('Orgrimmar');
    expect(() => num(row!, 'Level')).toThrow('not a number');
    expect(() => str(row!, 'Missing')).toThrow('Column Missing is missing');
  });
});

describe('tables', () => {
  it('reads a locale separately from the default enUS table', async () => {
    const tables = memoryTables({
      Map: [{ ID: '389', MapName_lang: 'Ragefire Chasm' }],
      'Map:esMX': [{ ID: '389', MapName_lang: 'Sima Ígnea' }],
    });
    expect((await tables.read('Map'))[0]!.MapName_lang).toBe('Ragefire Chasm');
    expect((await tables.read('Map', 'esMX'))[0]!.MapName_lang).toBe('Sima Ígnea');
    await expect(tables.read('Map', 'deDE')).rejects.toThrow('Map:deDE');
  });
});

describe('output', () => {
  it('writes sorted, escaped Lua tables and breaks lines at StyLua width', () => {
    expect(luaValue({ b: 'say "hi"\n', a: [1, true], end: 2, '7': 'x' })).toBe(
      '{ [7] = "x", a = { 1, true }, b = "say \\"hi\\"\\n", ["end"] = 2 }',
    );
    expect(luaValue({ items: Array.from({ length: 30 }, (_, i) => i) }).split('\n')[0]).toBe('{');
    expect(luaModule('Sample', ['Generated.'], { a: 1 })).toBe(
      '-- Generated.\nlocal _, ns = ...\n\nns.Data.Sample = { a = 1 }\n',
    );
    expect(() => luaValue({ a: Number.NaN })).toThrow();
  });

  it('renders Lua for the addon and sorted JSON for the bridge, both naming the build', () => {
    const base = {
      name: 'sample',
      description: 'Sample.',
      tables: ['Map'],
      build: async () => ({}),
    };
    const lua: Dataset = { ...base, output: { format: 'lua', path: 'a.lua', name: 'Sample' } };
    const json: Dataset = { ...base, output: { format: 'json', path: 'a.json' } };
    expect(render(lua, { a: 1 }, '1.2')).toContain('build 1.2 game tables (Map)');
    const parsed = JSON.parse(render(json, { b: 1, a: { d: 2, c: undefined } }, '1.2'));
    expect(parsed.generated).toMatchObject({ dataset: 'sample', build: '1.2', tables: ['Map'] });
    expect(JSON.stringify(parsed.data)).toBe('{"a":{"d":2},"b":1}');
  });
});

describe('coordinates', () => {
  it('converts a world position to a UI map and lists every zone that contains it', () => {
    expect(mapPosition(ASSIGNMENTS, 1413, 1, ...WAILING)).toEqual({ mapId: 1413, x: 47.7, y: 35 });
    expect(mapPosition(ASSIGNMENTS, 1454, 1, ...WAILING)).toBeNull();
    expect(zonesAt(ASSIGNMENTS, UI_MAPS, 1, ...WAILING).map((zone) => zone.name)).toEqual([
      'Durotar',
      'The Barrens',
    ]);
    expect(zonesAt(ASSIGNMENTS, UI_MAPS, 1, ...RAGEFIRE)).toEqual([
      { mapId: 1454, name: 'Orgrimmar', x: 53, y: 48.9 },
    ]);
  });
});

describe('dungeon entrances', () => {
  const map = (
    ID: string,
    MapName_lang: string,
    InstanceType: string,
    CorpseMapID: string,
    [x, y]: readonly [number, number],
  ) => ({
    ID,
    MapName_lang,
    InstanceType,
    CorpseMapID,
    Corpse_0: String(x),
    Corpse_1: String(y),
    MaxPlayers: '10',
  });
  const MAPS = [
    map('43', 'Wailing Caverns', '1', '1', WAILING),
    map('389', 'Ragefire Chasm', '1', '1', RAGEFIRE),
    map('2999', 'Ruins of Lordaeron', '1', '-1', [0, 0]),
    map('44', '<unused> Monastery', '1', '1', WAILING),
    map('1', 'Kalimdor', '0', '-1', [0, 0]),
  ];
  const curation: EntranceCuration = {
    zones: { '43': [1413] },
    entrances: { '2999': { value: [1458, 72.5, 11.4], source: 'test' } },
    skip: { '44': 'unused' },
  };
  const tables = memoryTables({ Map: MAPS, UiMap: UI_MAPS, UiMapAssignment: ASSIGNMENTS });
  const build = (change: Partial<EntranceCuration>) =>
    dungeonEntrances({ ...curation, ...change }).build(tables);

  it('places entrances on the only zone or the curated one and adds curated points', async () => {
    expect(await build({})).toEqual({
      '43': { name: 'Wailing Caverns', raid: false, entrances: [[1413, 47.7, 35]] },
      '389': { name: 'Ragefire Chasm', raid: false, entrances: [[1454, 53, 48.9]] },
      '2999': { name: 'Ruins of Lordaeron', raid: false, entrances: [[1458, 72.5, 11.4]] },
    });
  });

  it('asks for a zone with its candidates, and rejects curation that is wrong or not needed', async () => {
    await expect(build({ zones: {} })).rejects.toThrow(
      'Wailing Caverns (43): choose its zone in curated/dungeon-entrances.json from 1411 Durotar',
    );
    await expect(build({ zones: { '43': [1454] } })).rejects.toThrow(
      'zone 1454 does not contain its entrance',
    );
    await expect(build({ zones: { '43': [1413], '389': [1454] } })).rejects.toThrow(
      'Ragefire Chasm (389): only one zone contains its entrance',
    );
    await expect(build({ zones: { '43': [1413], '9999': [1413] } })).rejects.toThrow(
      'Curated instance 9999',
    );
  });
});

describe('generated files', () => {
  it('each dataset output is generated from the pinned build', async () => {
    for (const dataset of datasets()) {
      const file = await readFile(
        new URL(`../../../${dataset.output.path}`, import.meta.url),
        'utf8',
      );
      expect(file).toContain(`(dataset "${dataset.name}")`);
      expect(file).toContain(`build ${pinned.build} game tables`);
    }
  });
});
