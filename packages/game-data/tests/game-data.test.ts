import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path, Schema } from 'effect';
import {
  datasets,
  decodeTable,
  latestBuild,
  luaModule,
  luaValue,
  mapPosition,
  readPinned,
  render,
  UiMapAssignmentRow,
  UiMapRow,
  zonesAt,
  type Dataset,
} from '../src/index.ts';
import { dungeonEntrances, type EntranceCuration } from '../src/datasets/dungeon-entrances.ts';
import * as Wago from '../src/wago.ts';
import { cannedHttp } from './canned-http.ts';

// Real rows from Forever 1.60.1.71037: Durotar, The Barrens and Orgrimmar.
const ASSIGNMENTS = [
  'UiMin_0,UiMin_1,UiMax_0,UiMax_1,Region_0,Region_1,Region_2,Region_3,Region_4,Region_5,ID,UiMapID,OrderIndex,MapID,AreaID',
  '0,0,1,1,-1716.6666259766,-7249.9995117188,-1000000,1808.3332519531,-1962.4998779297,1000000,46721,1411,0,1,14',
  '0,0,1,1,-5143.75,-7510.4165039062,-1000000,1612.4998779297,2622.9165039062,1000000,46723,1413,0,1,17',
  '0,0,1,1,1338.4605712891,-5083.2055664062,-1000000,2273.8771972656,-3680.6010742188,1000000,46764,1454,0,1,1637',
].join('\n');
const UI_MAPS =
  'Name_lang,ID,ParentUiMapID,Flags,System,Type\nDurotar,1411,1414,2,0,3\n"The Barrens",1413,1414,2,0,3\nOrgrimmar,1454,1414,0,0,3\nKalimdor,1414,947,0,0,2';
const NamedRow = Schema.Struct({ ID: Schema.Int, Name: Schema.String });
// A table's decoding failure, as GameTables reports it.
const tableError = (text: string) =>
  Wago.GameTables.use((tables) => tables.read('Sample', NamedRow)).pipe(
    Effect.provide(Wago.layerMemory({ Sample: text })),
    Effect.flip,
    Effect.map((error) => error.message),
  );
// Map.db2 entrances on Kalimdor: Wailing Caverns lies inside both Durotar's
// and The Barrens' bounds; Ragefire Chasm only inside Orgrimmar's.
const WAILING = [-751.131, -2209.24] as const;
const RAGEFIRE = [1816.756, -4423.372] as const;
// A JSON dataset file as render() writes it.
const decodeJsonOutput = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      generated: Schema.Struct({
        dataset: Schema.String,
        build: Schema.String,
        tables: Schema.Array(Schema.String),
        note: Schema.String,
      }),
      data: Schema.Json,
    }),
  ),
);

describe('csv tables', () => {
  it.effect('reads quoted cells, doubled quotes, commas and CRLF line ends', () =>
    Effect.gen(function* () {
      const Row = Schema.Struct({ ID: Schema.Int, Name: Schema.String, Note: Schema.String });
      expect(
        yield* decodeTable('ID,Name,Note\r\n1,"Zul\'Farrak","a ""b"", c"\r\n2,Plain,\r\n', Row),
      ).toEqual([
        { ID: 1, Name: "Zul'Farrak", Note: 'a "b", c' },
        { ID: 2, Name: 'Plain', Note: '' },
      ]);
    }),
  );

  it.effect('decodes only the columns a row names, as numbers or text', () =>
    Effect.gen(function* () {
      const Row = Schema.Struct({ ID: Schema.Int, X: Schema.Finite, Name: Schema.String });
      expect(yield* decodeTable('Name,Flags,X,ID\nOrgrimmar,0x10,-1716.6666259766,7', Row)).toEqual(
        [{ ID: 7, X: -1716.6666259766, Name: 'Orgrimmar' }],
      );
    }),
  );

  it.effect('strips a byte order mark and skips blank lines', () =>
    Effect.gen(function* () {
      expect(yield* decodeTable('﻿ID,Name\n1,Durotar\n\n2,Mulgore\n', NamedRow)).toEqual([
        { ID: 1, Name: 'Durotar' },
        { ID: 2, Name: 'Mulgore' },
      ]);
    }),
  );

  it.effect('keeps a line holding only an empty quoted cell as a record', () =>
    Effect.gen(function* () {
      const Row = Schema.Struct({ Name: Schema.String });
      expect(yield* decodeTable('Name\nDurotar\n""\nMulgore', Row)).toEqual([
        { Name: 'Durotar' },
        { Name: '' },
        { Name: 'Mulgore' },
      ]);
    }),
  );

  it.effect('fails on stray quotes, a ragged record, or a missing, empty or malformed cell', () =>
    Effect.gen(function* () {
      expect(yield* tableError('ID,Name\n1,Zul"Farrak')).toBe(
        'Table Sample: line 2: Unexpected quote in an unquoted field',
      );
      expect(yield* tableError('ID,Name\n1,"Durotar')).toBe(
        'Table Sample: line 2: Unterminated quoted field',
      );
      expect(yield* tableError('ID,Name\n1,Durotar\n""')).toBe(
        'Table Sample: line 3: Expected 2 cells, got 1',
      );
      // Schema issues name the record (the header is record 1) and the column.
      expect(yield* tableError('ID,Title\n1,Durotar')).toBe(
        'Table Sample: Missing key\n  at [2]["Name"]',
      );
      expect(yield* tableError('ID,Name\n1,Durotar\nabc,Mulgore')).toBe(
        'Table Sample: Expected a string representing a finite number\n  at [3]["ID"]',
      );
      expect(yield* tableError('ID,Name\n,Durotar')).toBe(
        'Table Sample: Expected a string representing a finite number\n  at [2]["ID"]',
      );
      expect(yield* tableError('ID,Name\n1.5,Durotar')).toBe(
        'Table Sample: Expected an integer\n  at [2]["ID"]',
      );
    }),
  );
});

describe('tables', () => {
  it.effect('reads a locale separately from the default enUS table', () =>
    Effect.gen(function* () {
      const tables = yield* Wago.GameTables;
      const Row = Schema.Struct({ ID: Schema.Int, MapName_lang: Schema.String });
      expect((yield* tables.read('Map', Row))[0]?.MapName_lang).toBe('Ragefire Chasm');
      expect((yield* tables.read('Map', Row, 'esMX'))[0]?.MapName_lang).toBe('Sima Ígnea');
      const missing = yield* Effect.flip(tables.read('Map', Row, 'deDE'));
      expect(missing.message).toContain('Map:deDE');
    }).pipe(
      Effect.provide(
        Wago.layerMemory({
          Map: 'ID,MapName_lang\n389,Ragefire Chasm',
          'Map:esMX': 'ID,MapName_lang\n389,Sima Ígnea',
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
      const Row = Schema.Struct({ ID: Schema.Int, MapName_lang: Schema.String });
      const read = (refresh: boolean) =>
        Wago.GameTables.use((tables) => tables.read('Map', Row, 'esMX')).pipe(
          Effect.provide(
            Wago.layer({ build: '1.2.3', cacheDir, refresh }).pipe(Layer.provide(http.layer)),
          ),
        );
      expect(yield* read(false)).toEqual([{ ID: 389, MapName_lang: 'Ragefire Chasm' }]);
      expect(yield* read(false)).toEqual([{ ID: 389, MapName_lang: 'Ragefire Chasm' }]);
      expect(http.sent).toHaveLength(1);
      expect(http.sent[0]?.url.href).toBe('https://wago.tools/db2/Map/csv?build=1.2.3&locale=esMX');
      expect(http.sent[0]?.request.headers['user-agent']).toBe('wisp-game-data');
      expect(yield* fs.readFileString(path.join(cacheDir, '1.2.3', 'esMX', 'Map.csv'))).toBe(
        'ID,MapName_lang\n389,"Ragefire Chasm"\n',
      );
      yield* read(true);
      expect(http.sent).toHaveLength(2);
      // A cached table that does not decode fails instead of being downloaded again.
      yield* fs.writeFileString(
        path.join(cacheDir, '1.2.3', 'esMX', 'Map.csv'),
        'ID,MapName_lang\n389,Ragefire "Chasm"\n',
      );
      expect(yield* Effect.flip(read(false))).toMatchObject({
        _tag: 'TableReadError',
        message:
          'wago.tools Map (esMX) for build 1.2.3: line 2: Unexpected quote in an unquoted field',
      });
      expect(http.sent).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect('names the table, locale and build when wago.tools refuses a download', () => {
    const http = cannedHttp(() => new Response('Not found', { status: 404 }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const error = yield* Wago.GameTables.use((tables) => tables.read('UiMap', UiMapRow)).pipe(
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

  it.effect('renders Lua for the addon and sorted JSON for the bridge, both naming the build', () =>
    Effect.gen(function* () {
      const base = {
        name: 'sample',
        description: 'Sample.',
        tables: ['Map'],
        build: Effect.succeed({}),
      };
      const lua: Dataset = { ...base, output: { format: 'lua', path: 'a.lua', name: 'Sample' } };
      const json: Dataset = { ...base, output: { format: 'json', path: 'a.json' } };
      expect(render(lua, { a: 1 }, '1.2')).toContain('build 1.2 game tables (Map)');
      const parsed = yield* decodeJsonOutput(
        render(json, { b: 1, a: { d: 2, c: undefined } }, '1.2'),
      );
      expect(parsed.generated).toMatchObject({ dataset: 'sample', build: '1.2', tables: ['Map'] });
      expect(JSON.stringify(parsed.data)).toBe('{"a":{"d":2},"b":1}');
    }),
  );
});

describe('coordinates', () => {
  it.effect('converts a world position to a UI map and lists every zone that contains it', () =>
    Effect.gen(function* () {
      const assignments = yield* decodeTable(ASSIGNMENTS, UiMapAssignmentRow);
      const uiMaps = yield* decodeTable(UI_MAPS, UiMapRow);
      expect(mapPosition(assignments, 1413, 1, ...WAILING)).toEqual({
        mapId: 1413,
        x: 47.7,
        y: 35,
      });
      expect(mapPosition(assignments, 1454, 1, ...WAILING)).toBeNull();
      expect(zonesAt(assignments, uiMaps, 1, ...WAILING).map((zone) => zone.name)).toEqual([
        'Durotar',
        'The Barrens',
      ]);
      expect(zonesAt(assignments, uiMaps, 1, ...RAGEFIRE)).toEqual([
        { mapId: 1454, name: 'Orgrimmar', x: 53, y: 48.9 },
      ]);
    }),
  );
});

describe('dungeon entrances', () => {
  const map = (
    ID: number,
    MapName_lang: string,
    InstanceType: number,
    CorpseMapID: number,
    [x, y]: readonly [number, number],
  ) => [ID, `"${MapName_lang}"`, InstanceType, CorpseMapID, x, y, 10].join(',');
  const MAPS = [
    'ID,MapName_lang,InstanceType,CorpseMapID,Corpse_0,Corpse_1,MaxPlayers',
    map(43, 'Wailing Caverns', 1, 1, WAILING),
    map(389, 'Ragefire Chasm', 1, 1, RAGEFIRE),
    map(2999, 'Ruins of Lordaeron', 1, -1, [0, 0]),
    map(44, '<unused> Monastery', 1, 1, WAILING),
    map(1, 'Kalimdor', 0, -1, [0, 0]),
  ].join('\n');
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
          const { generated } = yield* decodeJsonOutput(file);
          expect(generated).toMatchObject({ dataset: dataset.name, build: pinned.build });
        } else {
          expect(file).toContain(`(dataset "${dataset.name}")`);
          expect(file).toContain(`build ${pinned.build} game tables`);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
