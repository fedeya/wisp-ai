import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  datasets,
  luaModule,
  luaValue,
  mapPosition,
  memoryTables,
  parseCsv,
  pinned,
} from '../src/index.ts';
import { dungeonEntrances, type EntranceCuration } from '../src/datasets/dungeon-entrances.ts';

// The Barrens' and Orgrimmar's UiMapAssignment rows from Forever 1.60.1.70888.
const ASSIGNMENTS = parseCsv(
  [
    'UiMin_0,UiMin_1,UiMax_0,UiMax_1,Region_0,Region_1,Region_2,Region_3,Region_4,Region_5,ID,UiMapID,OrderIndex,MapID,AreaID',
    '0,0,1,1,-5143.75,-7510.4165039062,-1000000,1612.4998779297,2622.9165039062,1000000,46723,1413,0,1,17',
    '0,0,1,1,1338.4605712891,-5083.2055664062,-1000000,2273.8771972656,-3680.6010742188,1000000,46764,1454,0,1,1637',
  ].join('\n'),
);

describe('csv', () => {
  it('reads quoted cells, doubled quotes, commas and CRLF line ends', () => {
    expect(parseCsv('ID,Name,Note\r\n1,"Zul\'Farrak","a ""b"", c"\r\n2,Plain,\r\n')).toEqual([
      { ID: '1', Name: "Zul'Farrak", Note: 'a "b", c' },
      { ID: '2', Name: 'Plain', Note: '' },
    ]);
  });
});

describe('lua', () => {
  it('writes sorted, escaped tables and breaks lines past 100 columns', () => {
    expect(luaValue({ b: 'say "hi"\n', a: [1, true], end: 2, '7': 'x' })).toBe(
      '{ [7] = "x", a = { 1, true }, b = "say \\"hi\\"\\n", ["end"] = 2 }',
    );
    const long = luaValue({ items: Array.from({ length: 30 }, (_, i) => i) });
    expect(long.split('\n')[0]).toBe('{');
    expect(luaModule('Sample', ['Generated.'], { a: 1 })).toBe(
      '-- Generated.\nlocal _, ns = ...\n\nns.Data.Sample = { a = 1 }\n',
    );
  });

  it('refuses values Lua cannot hold', () => {
    expect(() => luaValue({ a: Number.NaN })).toThrow();
  });
});

describe('coordinates', () => {
  it('converts a world position to the named UI map and refuses one outside it', () => {
    // Map.db2's Wailing Caverns and Ragefire Chasm entrances on Kalimdor.
    expect(mapPosition(ASSIGNMENTS, 1413, 1, -751.131, -2209.24)).toEqual({
      mapId: 1413,
      x: 47.7,
      y: 35,
    });
    expect(mapPosition(ASSIGNMENTS, 1454, 1, 1816.756, -4423.372)).toEqual({
      mapId: 1454,
      x: 53,
      y: 48.9,
    });
    expect(mapPosition(ASSIGNMENTS, 1454, 1, -751.131, -2209.24)).toBeNull();
  });
});

describe('dungeon entrances', () => {
  const curation: EntranceCuration = {
    zones: { '43': [1413] },
    entrances: { '2999': { value: [1458, 72.5, 11.4], source: 'test' } },
  };
  const maps = [
    {
      ID: '43',
      MapName_lang: 'Wailing Caverns',
      InstanceType: '1',
      CorpseMapID: '1',
      Corpse_0: '-751.131',
      Corpse_1: '-2209.24',
      MaxPlayers: '10',
    },
    {
      ID: '2999',
      MapName_lang: 'Ruins of Lordaeron',
      InstanceType: '1',
      CorpseMapID: '-1',
      Corpse_0: '0',
      Corpse_1: '0',
      MaxPlayers: '0',
    },
    {
      ID: '409',
      MapName_lang: 'Molten Core',
      InstanceType: '2',
      CorpseMapID: '0',
      Corpse_0: '1',
      Corpse_1: '1',
      MaxPlayers: '40',
    },
  ];

  it('places Map.db2 entrances on their zone and adds curated ones', async () => {
    const lua = await dungeonEntrances(curation).generate(
      memoryTables({ Map: maps, UiMapAssignment: ASSIGNMENTS }),
      '1.0',
    );
    expect(lua).toContain('build 1.0 game tables (Map, UiMapAssignment)');
    expect(lua).toContain(
      '[43] = { entrances = { { 1413, 47.7, 35 } }, name = "Wailing Caverns", raid = false },',
    );
    expect(lua).toContain(
      '[2999] = { entrances = { { 1458, 72.5, 11.4 } }, name = "Ruins of Lordaeron", raid = false },',
    );
    expect(lua).not.toContain('Molten Core');
  });

  it('fails when a named zone does not contain the entrance or an instance is missing', async () => {
    const wrongZone = { ...curation, zones: { '43': [1454] } };
    await expect(
      dungeonEntrances(wrongZone).generate(
        memoryTables({ Map: maps, UiMapAssignment: ASSIGNMENTS }),
        '1.0',
      ),
    ).rejects.toThrow('outside UI map 1454');
    const missing = { ...curation, zones: { '43': [1413], '9999': [1413] } };
    await expect(
      dungeonEntrances(missing).generate(
        memoryTables({ Map: maps, UiMapAssignment: ASSIGNMENTS }),
        '1.0',
      ),
    ).rejects.toThrow('9999');
  });
});

describe('generated files', () => {
  it('each dataset output is generated from the pinned build', async () => {
    for (const dataset of datasets()) {
      const file = await readFile(new URL(`../../../${dataset.output}`, import.meta.url), 'utf8');
      expect(file).toContain(`(dataset "${dataset.name}")`);
      expect(file).toContain(`build ${pinned.build} game tables`);
    }
  });
});
