import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adapters } from '../apps/bridge/src/integrations/simulation/adapters/index.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2]);
const output = path.join(root, 'simulator');
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
const spells = await readFile(path.join(source, 'sim/core/spelldata/spells_auto_gen.go'), 'utf8');
const main = JSON.parse(await readFile(path.join(source, 'assets/database/db.json'), 'utf8'));
const leftover = JSON.parse(
  await readFile(path.join(source, 'assets/database/leftover_db.json'), 'utf8'),
);
// Derive all rank IDs, levels and talent positions from the same pinned engine source.
const rows = new Map(
  [...spells.matchAll(/\t\{ID: (\d+),([\s\S]*?)(?=\n\t\{ID:|\n\})/g)].map((m) => [
    Number(m[1]),
    m[2],
  ]),
);
const unlevelled = await readFile(
  path.join(source, 'sim/core/spelldata/unlevelled_auto_gen.go'),
  'utf8',
);
const classData: Record<string, unknown> = {};
for (const adapter of Object.values(adapters)) {
  const name = adapter.token.toLowerCase();
  const generated = await readFile(
    path.join(source, 'sim', name, 'spell_data_auto_gen.go'),
    'utf8',
  );
  const talentTrees = JSON.parse(
    await readFile(path.join(source, 'ui/sim/talents/trees', name + '.json'), 'utf8'),
  );
  const ranks: Record<string, unknown[]> = {};
  const triggerParents: Record<number, number> = {};
  for (const family of adapter.families) {
    const match = generated.match(
      new RegExp('\\b' + family + ':\\s+spelldata\\.Ranked\\(([^)]+)\\)'),
    );
    if (!match) {
      throw Error('Missing engine spell family: ' + name + '/' + family);
    }
    ranks[family] = match[1].split(',').map((v) => {
      const id = Number(v.trim());
      const row = rows.get(id);
      if (!row) {
        throw Error('Missing engine spell: ' + id);
      }
      const field = (key: string) =>
        Number(row.match(new RegExp('\\b' + key + ': ([0-9.]+)'))?.[1] ?? 0);
      for (const trigger of row.matchAll(/TriggerID: (\d+)/g)) {
        triggerParents[Number(trigger[1])] = id;
      }
      return {
        id,
        level: new RegExp('\\b' + id + ':').test(unlevelled) ? 1 : field('SpellLevel') || 1,
        minRange: field('MinRange'),
        maxRange: field('MaxRange'),
      };
    });
  }
  if (adapter.token === 'PALADIN') {
    // These proc IDs are hand-built in the engine, outside the spell store.
    const sealSource = await readFile(
      path.join(source, 'sim/paladin/seal_of_righteousness.go'),
      'utf8',
    );
    const procTable = sealSource.match(
      /sealOfRighteousnessProcIDs = map\[int32\]int32\{([^}]+)\}/,
    )?.[1];
    if (!procTable) {
      throw Error('Missing Seal of Righteousness proc IDs.');
    }
    for (const pair of procTable.matchAll(/(\d+): (\d+)/g)) {
      const rank = (ranks.SealOfRighteousness as { id: number }[])[Number(pair[1]) - 1];
      if (!rank) {
        throw Error('Seal proc rank mismatch.');
      }
      triggerParents[Number(pair[2])] = rank.id;
    }
    const judgementIds = generated.match(
      /JudgementOfRighteousness:\s+spelldata\.Ranked\(([^)]+)\)/,
    )?.[1];
    if (!judgementIds) {
      throw Error('Missing Judgement of Righteousness ranks.');
    }
    for (const id of judgementIds.split(',')) {
      triggerParents[Number(id.trim())] = 20271;
    }
  }
  classData[adapter.token] = {
    talents: talentTrees.map((t: any) =>
      t.talents.map((x: any) => ({
        id: x.spellId,
        name: x.fancyName,
        max: x.maxPoints,
        row: x.location.rowIdx,
        ...(x.prereqLocation
          ? {
              prerequisiteId: t.talents.find(
                (p: any) =>
                  p.location.rowIdx === x.prereqLocation.rowIdx &&
                  p.location.colIdx === x.prereqLocation.colIdx,
              )?.spellId,
            }
          : {}),
      })),
    ),
    ranks,
    triggerParents,
  };
}
await writeFile(path.join(output, 'classes.json'), JSON.stringify(classData, null, 2) + '\n');
const catalog = [
  ...new Map([...main.items, ...leftover.items].map((i: any) => [i.id, i])).values(),
];
await writeFile(
  path.join(output, 'items.json'),
  JSON.stringify(
    catalog.map((i: any) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      armorType: i.armorType,
      weaponType: i.weaponType,
      handType: i.handType,
      rangedWeaponType: i.rangedWeaponType,
      reqLvl: i.reqLvl,
      classAllowlist: i.classAllowlist,
      unique: i.unique,
      limitCategory: i.limitCategory,
      requiredProfession: i.requiredProfession,
      factionRestriction: i.factionRestriction,
    })),
  ) + '\n',
);
manifest.supportedClasses = Object.keys(adapters);
manifest.patches = [
  {
    file: 'scripts/simulator-downranking.patch',
    sha256: createHash('sha256')
      .update(await readFile(path.join(root, 'scripts/simulator-downranking.patch')))
      .digest('hex'),
  },
];
delete manifest.supportedClass;
manifest.wandIds = [
  ...new Set(
    [...main.items, ...leftover.items].filter((i) => i.rangedWeaponType === 5).map((i) => i.id),
  ),
];
delete manifest.ranks;
delete manifest.triggerParents;
await copyFile(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-WoWSims.txt'));
manifest.sha256 = createHash('sha256')
  .update(await readFile(path.join(output, 'wowsimcli.exe')))
  .digest('hex');
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
