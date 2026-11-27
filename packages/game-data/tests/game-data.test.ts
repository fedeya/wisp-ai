import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path } from 'effect';
import {
  datasets,
  latestBuild,
  luaModule,
  luaValue,
  mapPosition,
  num,
  parseCsv,
  readPinned,
  render,
  str,
  zonesAt,
  type Dataset,
} from '../src/index.ts';
import { dungeonEntrances, type EntranceCuration } from '../src/datasets/dungeon-entrances.ts';
import * as Wago from '../src/wago.ts';
import { cannedHttp } from './canned-http.ts';

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
  it.effect('reads a locale separately from the default enUS table', () =>
    Effect.gen(function* () {
      const tables = yield* Wago.GameTables;
      expect((yield* tables.read('Map'))[0]!.MapName_lang).toBe('Ragefire Chasm');
      expect((yield* tables.read('Map', 'esMX'))[0]!.MapName_lang).toBe('Sima Ígnea');
      const missing = yield* Effect.flip(tables.read('Map', 'deDE'));
      expect(missing.message).toContain('Map:deDE');
    }).pipe(
      Effect.provide(
        Wago.layerMemory({
          Map: [{ ID: '389', MapName_lang: 'Ragefire Chasm' }],
          'Map:esMX': [{ ID: '389', MapName_lang: 'Sima Ígnea' }],
        }),
      ),
    ),
  );

  it.effect('downloads a table from wago.tools once and then reads it from the cache', () => {
    const http = cannedHttp(() => new Response('ID,MapName_lang\n389,"Ragefire Chasm"\n'));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const read = (refresh: boolean) =>
        Wago.GameTables.use((tables) => tables.read('Map', 'esMX')).pipe(
          Effect.provide(
            Wago.layer({ build: '1.2.3', cacheDir, refresh }).pipe(Layer.provide(http.layer)),
          ),
        );
      expect(yield* read(false)).toEqual([{ ID: '389', MapName_lang: 'Ragefire Chasm' }]);
      expect(yield* read(false)).toEqual([{ ID: '389', MapName_lang: 'Ragefire Chasm' }]);
      expect(http.sent).toHaveLength(1);
      expect(http.sent[0]?.url.href).toBe('https://wago.tools/db2/Map/csv?build=1.2.3&locale=esMX');
      expect(http.sent[0]?.request.headers['user-agent']).toBe('wisp-game-data');
      expect(yield* fs.readFileString(path.join(cacheDir, '1.2.3', 'esMX', 'Map.csv'))).toBe(
        'ID,MapName_lang\n389,"Ragefire Chasm"\n',
      );
      yield* read(true);
      expect(http.sent).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect('names the table, locale and build when wago.tools refuses a download', () => {
    const http = cannedHttp(() => new Response('Not found', { status: 404 }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const error = yield* Wago.GameTables.use((tables) => tables.read('UiMap')).pipe(
        Effect.provide(
          Wago.layer({ build: '1.2.3', cacheDir, refresh: false }).pipe(Layer.provide(http.layer)),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'TableReadError',
        message: 'wago.tools UiMap (enUS) for build 1.2.3: HTTP 404',
      });
      expect(http.sent[0]?.url.href).toBe('https://wago.tools/db2/UiMap/csv?build=1.2.3');
    }).pipe(Effect.provide(NodeServices.layer));
  });
});

describe('latest build', () => {
  it.effect("reads the newest build of a product from wago.tools' build list", () => {
    const http = cannedHttp(() =>
      Response.json({
        wowf: [
          { version: '1.60.1.71139', created_at: '2026-11-25 19:13:07', is_bgdl: false },
          { version: '1.60.1.71091', created_at: '2026-11-24 15:21:07', is_bgdl: false },
        ],
        wow: [{ unexpected: true }],
      }),
    );
    return Effect.gen(function* () {
      expect(yield* latestBuild('wowf')).toEqual({
        version: '1.60.1.71139',
        created: '2026-11-25 19:13:07',
      });
      expect(http.sent[0]?.url.href).toBe('https://wago.tools/api/builds');
      expect(http.sent[0]?.request.headers['user-agent']).toBe('wisp-game-data');
      const missing = yield* Effect.flip(latestBuild('wowx'));
      expect(missing.message).toBe('wago.tools lists no builds for wowx');
    }).pipe(Effect.provide(http.layer));
  });

  it.effect('fails with the HTTP status when the build list is unavailable', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(latestBuild('wowf'));
      expect(error).toMatchObject({
        _tag: 'BuildListError',
        message: 'wago.tools builds: HTTP 403',
      });
    }).pipe(Effect.provide(cannedHttp(() => new Response('', { status: 403 })).layer)),
  );
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
      build: Effect.succeed({}),
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
  const tables = Layer.mergeAll(
    Wago.layerMemory({ Map: MAPS, UiMap: UI_MAPS, UiMapAssignment: ASSIGNMENTS }),
    NodeServices.layer,
  );
  const build = (change: Partial<EntranceCuration>) =>
    dungeonEntrances({ ...curation, ...change }).build.pipe(Effect.provide(tables));
  const problem = (change: Partial<EntranceCuration>) =>
    build(change).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    );

  it.effect('places entrances on the only zone or the curated one and adds curated points', () =>
    Effect.gen(function* () {
      expect(yield* build({})).toEqual({
        '43': { name: 'Wailing Caverns', raid: false, entrances: [[1413, 47.7, 35]] },
        '389': { name: 'Ragefire Chasm', raid: false, entrances: [[1454, 53, 48.9]] },
        '2999': { name: 'Ruins of Lordaeron', raid: false, entrances: [[1458, 72.5, 11.4]] },
      });
    }),
  );

  it.effect(
    'asks for a zone with its candidates, and rejects curation that is wrong or not needed',
    () =>
      Effect.gen(function* () {
        expect(yield* problem({ zones: {} })).toContain(
          'Wailing Caverns (43): choose its zone in curated/dungeon-entrances.json from 1411 Durotar',
        );
        expect(yield* problem({ zones: { '43': [1454] } })).toContain(
          'zone 1454 does not contain its entrance',
        );
        expect(yield* problem({ zones: { '43': [1413], '389': [1454] } })).toContain(
          'Ragefire Chasm (389): only one zone contains its entrance',
        );
        expect(yield* problem({ zones: { '43': [1413], '9999': [1413] } })).toContain(
          'Curated instance 9999',
        );
      }),
  );
});

describe('generated files', () => {
  it.effect('each dataset output is generated from the pinned build', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('../../..', import.meta.url));
      const pinned = yield* readPinned;
      for (const dataset of datasets) {
        const file = yield* fs.readFileString(path.join(root, dataset.output.path));
        if (dataset.output.format === 'json') {
          const { generated } = JSON.parse(file);
          expect(generated).toMatchObject({ dataset: dataset.name, build: pinned.build });
        } else {
          expect(file).toContain(`(dataset "${dataset.name}")`);
          expect(file).toContain(`build ${pinned.build} game tables`);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
