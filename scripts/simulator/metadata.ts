// @effect-migrated
// Derives the simulator's class and item metadata from the pinned WoWSims
// source, and records the patches and binary in its manifest.
//   node scripts/simulator/metadata.ts <wowsims source folder>
import { createHash } from 'node:crypto';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { adapters } from '../../apps/server/src/integrations/simulation/adapters/index.ts';
import { runScript } from '../run-script.ts';

export class SimulatorSourceMismatch extends Schema.TaggedError<SimulatorSourceMismatch>()(
  'SimulatorSourceMismatch',
  { message: Schema.String },
) {}

const Location = Schema.Struct({ rowIdx: Schema.Finite, colIdx: Schema.Finite });
/** A class's talent trees in the WoWSims UI, as far as the metadata reads them. */
const TalentTrees = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      talents: Schema.Array(
        Schema.Struct({
          spellId: Schema.optionalKey(Schema.Finite),
          fancyName: Schema.optionalKey(Schema.String),
          maxPoints: Schema.optionalKey(Schema.Finite),
          location: Location,
          prereqLocation: Schema.optionalKey(Location),
        }),
      ),
    }),
  ),
);
/** The item fields items.json keeps, in its order; absent fields stay absent. */
const Item = Schema.Struct({
  id: Schema.Finite,
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Finite),
  armorType: Schema.optionalKey(Schema.Finite),
  weaponType: Schema.optionalKey(Schema.Finite),
  handType: Schema.optionalKey(Schema.Finite),
  rangedWeaponType: Schema.optionalKey(Schema.Finite),
  reqLvl: Schema.optionalKey(Schema.Finite),
  classAllowlist: Schema.optionalKey(Schema.Array(Schema.Finite)),
  unique: Schema.optionalKey(Schema.Boolean),
  limitCategory: Schema.optionalKey(Schema.Finite),
  requiredProfession: Schema.optionalKey(Schema.Finite),
  factionRestriction: Schema.optionalKey(Schema.Finite),
});
const ItemDatabase = Schema.fromJsonString(Schema.Struct({ items: Schema.Array(Item) }));
/** The manifest keeps every field this script does not rewrite, in place. */
const Manifest = Schema.fromJsonString(Schema.JsonObject);

interface SpellRank {
  readonly id: number;
  readonly level: number;
  readonly minRange: number;
  readonly maxRange: number;
}

const missing = (message: string) => new SimulatorSourceMismatch({ message });

/** Rewrites classes.json, items.json, the manifest and the license in `root`'s simulator folder from `source`. */
export const writeSimulatorMetadata = Effect.fnUntraced(function* (root: string, source: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = path.join(root, 'simulator');
  const read = (...segments: string[]) => fs.readFileString(path.join(...segments));
  const manifest = yield* Schema.decodeEffect(Manifest)(yield* read(output, 'manifest.json'));
  const spells = yield* read(source, 'sim/core/spelldata/spells_auto_gen.go');
  const main = yield* Schema.decodeEffect(ItemDatabase)(
    yield* read(source, 'assets/database/db.json'),
  );
  const leftover = yield* Schema.decodeEffect(ItemDatabase)(
    yield* read(source, 'assets/database/leftover_db.json'),
  );
  // Derive all rank IDs, levels and talent positions from the same pinned engine source.
  const rows = new Map(
    [...spells.matchAll(/\t\{ID: (\d+),([\s\S]*?)(?=\n\t\{ID:|\n\})/g)].map((m) => [
      Number(m[1]),
      m[2] ?? '',
    ]),
  );
  const unlevelled = yield* read(source, 'sim/core/spelldata/unlevelled_auto_gen.go');
  const classData: Record<string, unknown> = {};
  for (const adapter of Object.values(adapters)) {
    const name = adapter.token.toLowerCase();
    const generated = yield* read(source, 'sim', name, 'spell_data_auto_gen.go');
    const talentTrees = yield* Schema.decodeEffect(TalentTrees)(
      yield* read(source, 'ui/sim/talents/trees', name + '.json'),
    );
    const ranks: Record<string, SpellRank[]> = {};
    const triggerParents: Record<number, number> = {};
    for (const family of adapter.families) {
      const rankIds = generated.match(
        new RegExp('\\b' + family + ':\\s+spelldata\\.Ranked\\(([^)]+)\\)'),
      )?.[1];
      if (rankIds === undefined) {
        return yield* missing('Missing engine spell family: ' + name + '/' + family);
      }
      const familyRanks: SpellRank[] = [];
      for (const value of rankIds.split(',')) {
        const id = Number(value.trim());
        const row = rows.get(id);
        if (!row) {
          return yield* missing('Missing engine spell: ' + id);
        }
        const field = (key: string) =>
          Number(row.match(new RegExp('\\b' + key + ': ([0-9.]+)'))?.[1] ?? 0);
        for (const trigger of row.matchAll(/TriggerID: (\d+)/g)) {
          triggerParents[Number(trigger[1])] = id;
        }
        familyRanks.push({
          id,
          level: new RegExp('\\b' + id + ':').test(unlevelled) ? 1 : field('SpellLevel') || 1,
          minRange: field('MinRange'),
          maxRange: field('MaxRange'),
        });
      }
      ranks[family] = familyRanks;
    }
    if (adapter.token === 'PALADIN') {
      // These proc IDs are hand-built in the engine, outside the spell store.
      const sealSource = yield* read(source, 'sim/paladin/seal_of_righteousness.go');
      const procTable = sealSource.match(
        /sealOfRighteousnessProcIDs = map\[int32\]int32\{([^}]+)\}/,
      )?.[1];
      if (!procTable) {
        return yield* missing('Missing Seal of Righteousness proc IDs.');
      }
      for (const pair of procTable.matchAll(/(\d+): (\d+)/g)) {
        const rank = ranks.SealOfRighteousness?.[Number(pair[1]) - 1];
        if (!rank) {
          return yield* missing('Seal proc rank mismatch.');
        }
        triggerParents[Number(pair[2])] = rank.id;
      }
      const judgementIds = generated.match(
        /JudgementOfRighteousness:\s+spelldata\.Ranked\(([^)]+)\)/,
      )?.[1];
      if (!judgementIds) {
        return yield* missing('Missing Judgement of Righteousness ranks.');
      }
      for (const id of judgementIds.split(',')) {
        triggerParents[Number(id.trim())] = 20271;
      }
    }
    classData[adapter.token] = {
      talents: talentTrees.map((tree) =>
        tree.talents.map((talent) => {
          const prerequisite = talent.prereqLocation;
          return {
            id: talent.spellId,
            name: talent.fancyName,
            max: talent.maxPoints,
            row: talent.location.rowIdx,
            ...(prerequisite
              ? {
                  prerequisiteId: tree.talents.find(
                    (other) =>
                      other.location.rowIdx === prerequisite.rowIdx &&
                      other.location.colIdx === prerequisite.colIdx,
                  )?.spellId,
                }
              : {}),
          };
        }),
      ),
      ranks,
      triggerParents,
    };
  }
  yield* fs.writeFileString(
    path.join(output, 'classes.json'),
    JSON.stringify(classData, null, 2) + '\n',
  );
  const items = [...main.items, ...leftover.items];
  // The first item with an id keeps its place; a later one replaces its fields.
  const catalog = [...new Map(items.map((item) => [item.id, item])).values()];
  yield* fs.writeFileString(
    path.join(output, 'items.json'),
    JSON.stringify(
      catalog.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        armorType: item.armorType,
        weaponType: item.weaponType,
        handType: item.handType,
        rangedWeaponType: item.rangedWeaponType,
        reqLvl: item.reqLvl,
        classAllowlist: item.classAllowlist,
        unique: item.unique,
        limitCategory: item.limitCategory,
        requiredProfession: item.requiredProfession,
        factionRestriction: item.factionRestriction,
      })),
    ) + '\n',
  );
  const patch = yield* fs.readFile(path.join(root, 'scripts/simulator/downranking.patch'));
  const wandIds = [
    ...new Set(items.filter((item) => item.rangedWeaponType === 5).map((item) => item.id)),
  ];
  yield* fs.copyFile(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-WoWSims.txt'));
  const binary = yield* fs.readFile(path.join(output, 'wowsimcli.exe'));
  // Earlier manifests kept these fields; the class metadata now holds them.
  const retired = new Set(['supportedClass', 'ranks', 'triggerParents']);
  const kept = Object.fromEntries(Object.entries(manifest).filter(([key]) => !retired.has(key)));
  yield* fs.writeFileString(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        ...kept,
        supportedClasses: Object.keys(adapters),
        patches: [
          {
            file: 'scripts/simulator/downranking.patch',
            sha256: createHash('sha256').update(patch).digest('hex'),
          },
        ],
        wandIds,
        sha256: createHash('sha256').update(binary).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
});

if (import.meta.main) {
  Command.make(
    'metadata',
    {
      source: Argument.String('source').pipe(Argument.withDescription('The WoWSims source folder')),
    },
    Effect.fn(function* ({ source }) {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('../../', import.meta.url));
      yield* writeSimulatorMetadata(root, path.resolve(source));
    }),
  ).pipe(
    Command.withDescription("Refresh the simulator's metadata from its pinned source"),
    Command.run({ version: '1.0.0' }),
    runScript,
  );
}
