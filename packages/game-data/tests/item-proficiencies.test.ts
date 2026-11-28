import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { itemProficiencies } from '../src/datasets/item-proficiencies.ts';
import * as Wago from '../src/wago.ts';

// Real Forever 1.60.1.71037 rows: Bows, Plate Mail, Daggers, Unarmed and
// Defense; Unarmed and Defense reach every class, so they gate no item.
const TABLES = Wago.layerMemory({
  SkillLine:
    'ID,CategoryID,DisplayName_lang\n45,6,Bows\n293,8,Plate Mail\n173,6,Daggers\n162,6,Unarmed\n95,6,Defense\n185,9,Cooking',
  SkillLineAbility:
    'ID,SkillLine,Spell\n1,45,264\n2,293,750\n3,173,1180\n4,162,203\n5,95,107\n6,185,2550',
  SpellEquippedItems:
    'ID,SpellID,EquippedItemClass,EquippedItemInvTypes,EquippedItemSubclass\n1,264,2,0,4\n2,750,4,0,16\n3,1180,2,0,32768\n4,203,2,0,8192\n5,107,4,0,96',
  SkillRaceClassInfo: [
    'ID,SkillID,ClassMask,MinLevel',
    '126,45,4,0',
    '127,45,13,0',
    '21,293,3,40',
    '129,173,268,0',
    '323,173,208,0',
    '631,173,4,0',
    '900,162,1535,0',
    '901,95,1535,0',
  ].join('\n'),
  ChrClasses:
    'ID,Filename\n1,WARRIOR\n2,PALADIN\n3,HUNTER\n4,ROGUE\n5,PRIEST\n7,SHAMAN\n8,MAGE\n9,WARLOCK\n11,DRUID',
});

describe('item proficiencies dataset', () => {
  it.effect('maps item subclasses to the skill they need and the classes that learn it', () =>
    Effect.gen(function* () {
      expect(yield* itemProficiencies().build).toEqual({
        subclasses: { '2': { '2': 45, '15': 173 }, '4': { '4': 293 } },
        skills: {
          '45': { HUNTER: 0, ROGUE: 0, WARRIOR: 0 },
          '173': { HUNTER: 0, MAGE: 0, PRIEST: 0, ROGUE: 0, SHAMAN: 0, WARLOCK: 0 },
          '293': { PALADIN: 40, WARRIOR: 40 },
        },
      });
    }).pipe(Effect.provide(TABLES)),
  );
});
