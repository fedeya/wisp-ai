// @effect-migrated
import { Effect } from 'effect';
import type { Row } from '../csv.ts';
import { DatasetError, fromRows, type Dataset } from '../dataset.ts';
import type { LuaTable } from '../lua.ts';
import { num, str } from '../rows.ts';
import { GameTables } from '../wago.ts';

const ITEM_CLASSES = new Set([2, 4]); // weapon, armor
const SKILL_CATEGORIES = new Set([6, 8]); // weapon skills, armor proficiencies

// Item class -> subclass -> skill line, and skill line -> class token ->
// minimum level; or the first item subclass two skills claim.
function proficiencies(
  skillLines: Row[],
  abilities: Row[],
  equipped: Row[],
  raceClass: Row[],
  chrClasses: Row[],
): { table: LuaTable } | { conflict: string } {
  const proficiencySkills = new Set(
    skillLines
      .filter((row) => SKILL_CATEGORIES.has(num(row, 'CategoryID')))
      .map((row) => num(row, 'ID')),
  );
  const classTokens = new Map(chrClasses.map((row) => [num(row, 'ID'), str(row, 'Filename')]));
  const allClasses = [...classTokens.keys()].reduce((mask, id) => mask | (1 << (id - 1)), 0);

  // Skill line -> class token -> lowest level any row allows it.
  const classesBySkill = new Map<number, Map<string, number>>();
  for (const row of raceClass) {
    const skill = num(row, 'SkillID');
    if (!proficiencySkills.has(skill)) {
      continue;
    }
    const mask = num(row, 'ClassMask');
    const minLevel = num(row, 'MinLevel');
    for (const [id, token] of classTokens) {
      if (mask & (1 << (id - 1))) {
        const classes = classesBySkill.get(skill) ?? new Map<string, number>();
        classes.set(token, Math.min(classes.get(token) ?? Infinity, minLevel));
        classesBySkill.set(skill, classes);
      }
    }
  }
  // Skills every class gets (Defense, Unarmed) gate no item.
  const gating = (skill: number) => {
    const classes = classesBySkill.get(skill);
    if (!classes) {
      return false;
    }
    let mask = 0;
    for (const [id, token] of classTokens) {
      if (classes.has(token)) {
        mask |= 1 << (id - 1);
      }
    }
    return mask !== allClasses;
  };

  const equippedBySpell = new Map(equipped.map((row) => [num(row, 'SpellID'), row]));
  const subclasses: Record<string, Record<string, number>> = {};
  for (const ability of abilities) {
    const skill = num(ability, 'SkillLine');
    const items = equippedBySpell.get(num(ability, 'Spell'));
    if (!items || !proficiencySkills.has(skill) || !gating(skill)) {
      continue;
    }
    const itemClass = num(items, 'EquippedItemClass');
    if (!ITEM_CLASSES.has(itemClass) || num(items, 'EquippedItemInvTypes') !== 0) {
      continue;
    }
    const mask = num(items, 'EquippedItemSubclass');
    for (let subclass = 0; subclass < 31; subclass++) {
      if (!(mask & (1 << subclass))) {
        continue;
      }
      const bySubclass = (subclasses[String(itemClass)] ??= {});
      const previous = bySubclass[String(subclass)];
      if (previous !== undefined && previous !== skill) {
        return {
          conflict: `Item class ${itemClass} subclass ${subclass} maps to skills ${previous} and ${skill}`,
        };
      }
      bySubclass[String(subclass)] = skill;
    }
  }

  const skills: Record<string, Record<string, number>> = {};
  for (const bySubclass of Object.values(subclasses)) {
    for (const skill of Object.values(bySubclass)) {
      // gating() kept only skills that some class has.
      const classes = classesBySkill.get(skill) ?? new Map<string, number>();
      skills[String(skill)] = Object.fromEntries(
        [...classes].sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }
  return { table: { subclasses, skills } };
}

// Which weapon or armor skill each item subclass needs, and which classes can
// learn that skill from what level, so the addon can tell an item the player
// can equip from one they could train and one their class never uses.
// Read from Forever's own tables: the proficiency spells of each skill line
// (SkillLineAbility) name the item subclasses they allow (SpellEquippedItems),
// and SkillRaceClassInfo lists the classes that get the skill.
export function itemProficiencies(): Dataset<GameTables> {
  return {
    name: 'item-proficiencies',
    description:
      'Item class -> subclass -> weapon/armor skill line; skill line -> class token -> minimum level.',
    tables: [
      'SkillLine',
      'SkillLineAbility',
      'SpellEquippedItems',
      'SkillRaceClassInfo',
      'ChrClasses',
    ],
    output: {
      format: 'lua',
      path: 'addon/WispAI/Data/ItemProficiencies.lua',
      name: 'ItemProficiencies',
    },
    build: Effect.gen(function* () {
      const tables = yield* GameTables;
      const [skillLines, abilities, equipped, raceClass, chrClasses] = yield* Effect.all(
        [
          tables.read('SkillLine'),
          tables.read('SkillLineAbility'),
          tables.read('SpellEquippedItems'),
          tables.read('SkillRaceClassInfo'),
          tables.read('ChrClasses'),
        ],
        { concurrency: 'unbounded' },
      );
      const result = yield* fromRows(() =>
        proficiencies(skillLines, abilities, equipped, raceClass, chrClasses),
      );
      if ('conflict' in result) {
        return yield* new DatasetError({ message: result.conflict });
      }
      return result.table;
    }),
  };
}
