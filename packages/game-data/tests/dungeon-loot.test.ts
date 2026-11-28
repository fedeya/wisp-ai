import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { Digest } from 'effect/crypto';
import { atlasLootUrl, unzip, type AtlasLootPin } from '../src/index.ts';
import * as AtlasLoot from '../src/atlasloot.ts';
import { DungeonLoot, dungeonLoot } from '../src/datasets/dungeon-loot.ts';
import * as Wago from '../src/wago.ts';
import { cannedHttp } from './canned-http.ts';

const MODULE = 'AtlasLootClassic_DungeonsAndRaids';
// Shaped like AtlasLoot Classic Forever 1.4.8's data.lua: a classic instance
// named through C_Map.GetAreaInfo with a "Forever" header column, a Forever
// instance listed by name only, a boss without drops yet and a key list.
const DATA = `
local _G = getfenv(0)
local AtlasLoot = _G.AtlasLoot
local data = AtlasLoot.ItemDB:Add(..., 1, AtlasLoot.CLASSIC_VERSION_NUM)
local AL = AtlasLoot.Locales
local GetForVersion = AtlasLoot.ReturnForGameVersion
local NORMAL_DIFF = data:AddDifficulty("NORMAL", nil, nil, nil, true)
local SET_ITTYPE = data:AddItemTableType("Set", "Item")
local DUNGEON_CONTENT = data:AddContentType(AL["Dungeons"], ATLASLOOT_DUNGEON_COLOR)
local RAID40_CONTENT = data:AddContentType(AL["Raids"], ATLASLOOT_RAID40_COLOR)
local FOREVER_DUNGEON_CONTENT = data:AddContentType("Forever Dungeons", { 0.30, 0.50, 0.70, 1 })
local LTNX = "|cffffffff|TInterface\\\\AddOns\\\\AtlasLootClassic\\\\ltn4.tga:18:18:2:0|t|r"
data["Ragefire"] = {
  name = C_Map.GetAreaInfo(2437) .. LTNX,
  InstanceID = 389,
  ContentType = DUNGEON_CONTENT,
  LevelRange = GetForVersion({ 10, 13, 18 }, { 8, 13, 16 }),
  items = {
    { name = AL["Jergosh the Invoker"], npcID = 11518,
      [NORMAL_DIFF] = {
        { 1, 14150 }, -- Robe of Evocation
        { 2, 14147 },
        { 16, "INV_Box_01", nil, AL["Forever"], nil },
        { 17, 253906 },
      } },
    { name = AL["Keys"], IgnoreAsSource = true, [NORMAL_DIFF] = { { 1, 16309 } } },
    { name = "Sets", TableType = SET_ITTYPE, [NORMAL_DIFF] = { { 1, 203 } } },
  },
}
data["MoltenCore"] = {
  name = AL["MoltenCore"],
  InstanceID = 409,
  ContentType = RAID40_CONTENT,
  items = { { name = AL["Lucifron"], npcID = 12118, [NORMAL_DIFF] = { { 1, 16800 } } } },
}
data["TheAlcazPrison"] = {
  name = "Alcaz Prison" .. LTNX,
  ContentType = FOREVER_DUNGEON_CONTENT,
  LevelRange = { 45, 48, 53 },
  items = {
    { name = "Overseer Wrex", [NORMAL_DIFF] = { { 1, 276732 } } },
    { name = "Zarla Ober - No drops discovered yet", [NORMAL_DIFF] = {} },
    { name = AL["Trash"], ExtraList = true, [NORMAL_DIFF] = { { 1, 287020 } } },
  },
}
local frame = CreateFrame("Frame")
frame:SetScript("OnUpdate", function() end)
`;
const DROPRATE = `
local Droprate = _G.AtlasLoot.Data.Droprate
local DropRateData = { [11518] = { [14147] = 37.34, [14150] = 36.36 } }
Droprate:AddData(DropRateData)
`;
const FILES = new Map([
  [`${MODULE}/data.lua`, Buffer.from(DATA)],
  [`${MODULE}/droprate.lua`, Buffer.from(DROPRATE)],
]);
// Real Forever 1.60.1.71037 rows.
const TABLES = Wago.layerMemory({
  AreaTable: 'ID,AreaName_lang\n2437,"Ragefire Chasm"',
  Map: 'ID,MapName_lang,InstanceType\n389,"Ragefire Chasm",1\n409,"Molten Core",2\n2994,"Alcaz Prison",1\n1,Kalimdor,0',
});

function build(files = FILES, instanceMapIds = {}) {
  return dungeonLoot({ instanceMapIds }).build.pipe(
    Effect.provide(Layer.mergeAll(TABLES, AtlasLoot.layerFromFiles(files), NodeServices.layer)),
    Effect.flatMap(Schema.decodeUnknownEffect(DungeonLoot)),
  );
}

// A stored (uncompressed) zip with one entry, its folder written with a
// backslash the way some Windows tools write addon archives.
function storedZip(name: string, content: string) {
  const file = Buffer.from(content);
  const path = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(file.length, 18);
  local.writeUInt32LE(file.length, 22);
  local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(file.length, 20);
  central.writeUInt32LE(file.length, 24);
  central.writeUInt16LE(path.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + path.length, 12);
  end.writeUInt32LE(30 + path.length + file.length, 16);
  return Buffer.concat([local, path, file, central, path, end]);
}

describe('AtlasLoot source', () => {
  it('pins a CurseForge file and reads archives with either path separator', () => {
    expect(atlasLootUrl({ project: 1422985, file: 9763940, name: 'a.zip', sha256: '' })).toBe(
      'https://mediafilez.forgecdn.net/files/9763/940/a.zip',
    );
    const files = unzip(storedZip(`${MODULE}\\data.lua`, 'return 1'));
    expect(files.get(`${MODULE}/data.lua`)?.toString()).toBe('return 1');
  });

  // An archive whose module lacks droprate.lua, so a load that downloads,
  // verifies and unpacks it stops at running the loot files.
  const ARCHIVE = storedZip(`${MODULE}\\data.lua`, 'return 1');
  const load = (pin: AtlasLootPin, cacheDir: string, http: ReturnType<typeof cannedHttp>) =>
    AtlasLoot.AtlasLoot.use((source) => source.load(new Map())).pipe(
      Effect.provide(
        AtlasLoot.layer({ pin, cacheDir, refresh: false }).pipe(
          Layer.provide([http.layer, NodeCrypto.layerDigest]),
        ),
      ),
      Effect.flip,
      Effect.map((error) => error.message),
    );

  it.effect('downloads the pinned archive once, checks its hash and runs its loot files', () => {
    const http = cannedHttp(() => new Response(ARCHIVE));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const digest = yield* Digest.Digest;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const pin = {
        project: 1422985,
        file: 9763940,
        name: 'a.zip',
        sha256: yield* digest.digestHex(Digest.sha256, ARCHIVE),
      };
      const missing = `AtlasLoot archive has no ${MODULE}/droprate.lua`;
      expect(yield* load(pin, cacheDir, http)).toBe(missing);
      expect(yield* load(pin, cacheDir, http)).toBe(missing);
      expect(http.sent.map(({ url }) => url.href)).toEqual([
        'https://mediafilez.forgecdn.net/files/9763/940/a.zip',
      ]);
      const cached = yield* fs.readFile(path.join(cacheDir, 'atlasloot', 'a.zip'));
      expect(Buffer.from(cached).equals(ARCHIVE)).toBe(true);
      expect(yield* load({ ...pin, sha256: 'abc' }, cacheDir, http)).toBe(
        `AtlasLoot a.zip: sha256 ${pin.sha256} does not match the pin abc`,
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest)));
  });

  it.effect('names the archive when the download fails', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const pin = { project: 1422985, file: 9763940, name: 'a.zip', sha256: 'abc' };
      const http = cannedHttp(() => new Response('', { status: 404 }));
      expect(yield* load(pin, cacheDir, http)).toBe('AtlasLoot a.zip: HTTP 404');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe('dungeon loot dataset', () => {
  it.effect('lists each boss loot with Forever additions and drop rates', () =>
    Effect.gen(function* () {
      const { instances } = yield* build();
      const ragefire = instances.find((instance) => instance.key === 'Ragefire');
      expect(ragefire).toMatchObject({
        name: 'Ragefire Chasm',
        instanceMapId: 389,
        kind: 'dungeon',
        levels: { min: 10, recommended: 13, max: 18 },
      });
      expect(ragefire?.forever).toBeUndefined();
      expect(ragefire?.bosses).toEqual([
        {
          name: 'Jergosh the Invoker',
          npcIds: [11518],
          items: [
            { id: 14150, chance: 36.36 },
            { id: 14147, chance: 37.34 },
            { id: 253906, forever: true },
          ],
        },
      ]);
    }),
  );

  it.effect('names classic tables keyed by an AtlasLoot locale key after their map', () =>
    Effect.gen(function* () {
      const { instances } = yield* build();
      expect(instances.find((instance) => instance.key === 'MoltenCore')).toMatchObject({
        name: 'Molten Core',
        instanceMapId: 409,
        kind: 'raid',
      });
    }),
  );

  it.effect('places Forever instances by name and keeps bosses without drops', () =>
    Effect.gen(function* () {
      const { instances } = yield* build();
      const alcaz = instances.find((instance) => instance.key === 'TheAlcazPrison');
      expect(alcaz).toMatchObject({ name: 'Alcaz Prison', instanceMapId: 2994, forever: true });
      expect(alcaz?.bosses).toEqual([
        { name: 'Overseer Wrex', items: [{ id: 276732 }] },
        { name: 'Zarla Ober', noDropsYet: true, items: [] },
        { name: 'Trash', extra: true, items: [{ id: 287020 }] },
      ]);
    }),
  );

  it.effect('fails on an instance no map matches unless it is curated', () =>
    Effect.gen(function* () {
      const files = new Map(FILES);
      files.set(
        `${MODULE}/data.lua`,
        Buffer.from(DATA.replace('"Alcaz Prison" .. LTNX', '"Mount Hyjal" .. LTNX')),
      );
      const error = yield* Effect.flip(build(files));
      expect(error.message).toContain('TheAlcazPrison (Mount Hyjal)');
      const { instances } = yield* build(files, {
        TheAlcazPrison: { value: null, source: 'test' },
      });
      expect(instances.find((instance) => instance.key === 'TheAlcazPrison')?.instanceMapId).toBe(
        undefined,
      );
    }),
  );
});
