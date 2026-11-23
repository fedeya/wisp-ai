import { candidate, item, type Item } from './fedrath.ts';
import moltenCore from './molten-core.json' with { type: 'json' };

// The game's reading of Shadowfang Keep's and Wailing Caverns' AtlasLoot drops for Fedrath, a
// level 21 mage, as the addon's gear_candidates answers it. Item IDs, item
// class, subclass and inventory type are Forever's (Item.db2, build
// 1.60.1.71037); names, levels and stats are illustrative, since the client
// tables do not carry classic items' stats.
const INT = 'ITEM_MOD_INTELLECT_SHORT';
const STA = 'ITEM_MOD_STAMINA_SHORT';
const SPI = 'ITEM_MOD_SPIRIT_SHORT';
const STR = 'ITEM_MOD_STRENGTH_SHORT';
const AGI = 'ITEM_MOD_AGILITY_SHORT';
const SP = 'ITEM_MOD_SPELL_POWER_SHORT';

const INVENTORY: Record<number, string> = {
  1: 'INVTYPE_HEAD',
  2: 'INVTYPE_NECK',
  3: 'INVTYPE_SHOULDER',
  5: 'INVTYPE_CHEST',
  6: 'INVTYPE_WAIST',
  7: 'INVTYPE_LEGS',
  8: 'INVTYPE_FEET',
  9: 'INVTYPE_WRIST',
  11: 'INVTYPE_FINGER',
  12: 'INVTYPE_TRINKET',
  13: 'INVTYPE_WEAPON',
  14: 'INVTYPE_SHIELD',
  16: 'INVTYPE_CLOAK',
  17: 'INVTYPE_2HWEAPON',
  20: 'INVTYPE_ROBE',
  21: 'INVTYPE_WEAPONMAINHAND',
  23: 'INVTYPE_HOLDABLE',
  10: 'INVTYPE_HAND',
  15: 'INVTYPE_RANGED',
  26: 'INVTYPE_RANGEDRIGHT',
};

// id: [name, quality, itemLevel, requiredLevel, classID, subclassID, inventoryType, stats]
type Row = [string, number, number, number, number, number, number, Record<string, number>];
const ROWS: Record<number, Row> = {
  5254: ['Rugged Spaulders', 2, 23, 18, 4, 2, 3, { [AGI]: 3, [STA]: 3 }],
  273456: ['Rethilgore Claw', 3, 26, 21, 2, 13, 21, { [STR]: 4, [AGI]: 3 }],
  273457: ['Gravedirt Amulet', 3, 26, 21, 4, 0, 2, { [INT]: 4, [SP]: 4 }],
  6341: ['Eerie Stable Lantern', 2, 24, 19, 4, 0, 23, { [INT]: 2, [SPI]: 3 }],
  1292: ["Butcher's Cleaver", 3, 26, 21, 2, 0, 13, { [STR]: 4 }],
  6226: ['Bloody Apron', 2, 24, 19, 4, 1, 20, { [INT]: 3, [STA]: 4, [SPI]: 3 }],
  6633: ["Butcher's Slicer", 2, 24, 19, 2, 7, 13, { [STA]: 2, [SP]: 4 }],
  6321: ["Silverlaine's Family Seal", 3, 26, 21, 4, 0, 11, { [INT]: 3, [SPI]: 4 }],
  6323: ["Baron's Scepter", 2, 25, 20, 2, 4, 21, { [INT]: 3, [STA]: 2 }],
  273637: ["Silverlaine's Spellblade", 3, 27, 22, 2, 7, 21, { [INT]: 4, [SP]: 6 }],
  276631: ['Gilneas Officer Sabre', 2, 25, 20, 2, 7, 21, { [STR]: 3, [STA]: 3 }],
  6320: ["Commander's Crest", 3, 25, 20, 4, 6, 14, { [STA]: 5 }],
  3191: ['Arced War Axe', 2, 26, 21, 2, 1, 17, { [STR]: 7, [STA]: 4 }],
  273643: ['Springvale Reliquary', 3, 27, 22, 4, 0, 12, { [SP]: 7 }],
  6318: ["Odo's Ley Staff", 3, 26, 21, 2, 10, 17, { [INT]: 7, [SPI]: 6, [STA]: 3 }],
  6319: ['Girdle of the Blindwatcher', 3, 25, 20, 4, 2, 6, { [AGI]: 6 }],
  273645: ['Blindwatcher Hood', 3, 26, 21, 4, 1, 1, { [INT]: 6, [SP]: 4 }],
  6642: ['Phantom Armor', 3, 27, 22, 4, 3, 5, { [STR]: 5, [STA]: 6 }],
  6641: ['Haunting Blade', 3, 27, 22, 2, 8, 17, { [STR]: 8, [STA]: 4 }],
  5943: ['Rift Bracers', 3, 24, 19, 4, 3, 9, { [STA]: 4 }],
  6340: ["Fenrus' Hide", 3, 25, 20, 4, 1, 16, { [STA]: 4, [SPI]: 3 }],
  3230: ['Black Wolf Bracers', 2, 25, 20, 4, 2, 9, { [AGI]: 3 }],
  273646: ['Ravager Chain Boots', 3, 26, 21, 4, 3, 8, { [STR]: 4, [AGI]: 3 }],
  3748: ['Feline Mantle', 2, 25, 20, 4, 1, 3, { [INT]: 3, [SPI]: 3 }],
  6314: ['Wolfmaster Cape', 3, 26, 21, 4, 1, 16, { [AGI]: 4, [STA]: 3 }],
  273647: ["Nandos' Leggings", 3, 26, 21, 4, 2, 7, { [AGI]: 5, [STA]: 4 }],
  6324: ['Robes of Arugal', 3, 27, 22, 4, 1, 20, { [INT]: 7, [SPI]: 5, [SP]: 4 }],
  6392: ['Belt of Arugal', 3, 27, 22, 4, 1, 6, { [INT]: 5, [SPI]: 4 }],
  6220: ['Meteor Shard', 3, 27, 22, 2, 15, 13, { [SP]: 5 }],
  2292: ['Necrology Robes', 2, 25, 20, 4, 1, 20, { [INT]: 4, [SPI]: 4 }],
  1489: ['Gloomshroud Armor', 2, 26, 21, 4, 2, 5, { [AGI]: 4, [STA]: 4 }],
  1974: ['Mindthrust Bracers', 2, 25, 20, 4, 1, 9, { [INT]: 3 }],
  2807: ['Guillotine Axe', 2, 26, 21, 2, 0, 21, { [STR]: 3 }],
  1482: ['Shadowfang', 3, 26, 21, 2, 7, 21, { [AGI]: 2, [STA]: 2 }],
  1935: ["Assassin's Blade", 2, 26, 21, 2, 15, 13, { [AGI]: 3 }],
  1483: ['Face Smasher', 2, 26, 21, 2, 4, 13, { [STR]: 3 }],
  1318: ['Night Reaver', 2, 26, 21, 2, 1, 17, { [STR]: 6 }],
  3194: ['Black Malice', 2, 26, 21, 2, 5, 17, { [STR]: 6 }],
  2205: ['Duskbringer', 2, 26, 21, 2, 8, 17, { [STR]: 6 }],
  1484: ['Witching Stave', 2, 26, 21, 2, 10, 17, { [INT]: 6, [SPI]: 5 }],
  23173: ['Abomination Skin Leggings', 4, 28, 23, 4, 1, 7, { [INT]: 6, [STA]: 6, [SP]: 6 }],
  23171: ['The Axe of Severing', 4, 28, 23, 2, 1, 17, { [STR]: 10, [STA]: 8 }],
  // Wailing Caverns, named as AtlasLoot's source comments name them.
  6460: ["Cobrahn's Grasp", 3, 22, 17, 4, 3, 6, { [STR]: 3, [STA]: 3 }],
  10410: ['Leggings of the Fang', 3, 26, 21, 4, 2, 7, { [AGI]: 7, [STA]: 4 }],
  6465: ['Robe of the Moccasin', 2, 22, 17, 4, 1, 20, { [INT]: 4, [SPI]: 3 }],
  10412: ['Belt of the Fang', 3, 25, 20, 4, 2, 6, { [AGI]: 4, [STA]: 3 }],
  5404: ["Serpent's Shoulders", 2, 22, 17, 4, 2, 3, { [AGI]: 3, [STA]: 2 }],
  273088: ['Snake Eye Kaleidoscope', 3, 24, 19, 4, 0, 2, { [INT]: 4, [SPI]: 3 }],
  13245: ["Kresh's Back", 3, 22, 17, 4, 6, 14, { [STA]: 4 }],
  6447: ['Worn Turtle Shell Shield', 2, 20, 15, 4, 6, 14, { [STA]: 3 }],
  273084: ['Cloak of Hermitic Bliss', 3, 23, 18, 4, 1, 16, { [INT]: 3, [SPI]: 3 }],
  6472: ['Stinging Viper', 3, 24, 19, 2, 4, 13, { [STR]: 3 }],
  6473: ['Armor of the Fang', 3, 26, 21, 4, 2, 5, { [AGI]: 7, [STA]: 6 }],
  273089: ['Slither Cord', 3, 23, 18, 4, 1, 6, { [INT]: 3, [SP]: 3 }],
  6449: ['Glowing Lizardscale Cloak', 3, 22, 17, 4, 1, 16, { [AGI]: 3, [STA]: 2 }],
  6448: ['Tail Spike', 2, 22, 17, 2, 15, 13, { [AGI]: 2 }],
  273137: ["Skum's Bucket", 3, 23, 18, 4, 0, 23, { [INT]: 3, [SP]: 3 }],
  6469: ['Venomstrike', 3, 24, 19, 2, 2, 15, { [AGI]: 2 }],
  5970: ['Serpent Gloves', 2, 22, 17, 4, 1, 10, { [INT]: 3, [SPI]: 3 }],
  10411: ['Footpads of the Fang', 3, 25, 20, 4, 2, 8, { [AGI]: 4, [STA]: 3 }],
  6459: ['Savage Trodders', 3, 24, 19, 4, 3, 8, { [STR]: 4, [STA]: 3 }],
  6630: ['Seedcloud Buckler', 3, 24, 19, 4, 6, 14, { [STA]: 3, [SPI]: 3 }],
  6631: ['Living Root', 3, 24, 19, 2, 10, 17, { [INT]: 4, [SPI]: 9 }],
  6629: ['Sporid Cape', 3, 24, 19, 4, 1, 16, { [STA]: 3, [SPI]: 3 }],
  6461: ['Slime-encrusted Pads', 3, 24, 19, 4, 1, 3, { [INT]: 4, [STA]: 3 }],
  6627: ['Mutant Scale Breastplate', 3, 24, 19, 4, 3, 5, { [STR]: 5, [STA]: 5 }],
  6463: ['Deep Fathom Ring', 3, 24, 19, 4, 0, 11, { [STA]: 3, [SPI]: 3 }],
  5243: ['Firebelcher', 3, 24, 19, 2, 19, 26, { [INT]: 2 }],
  6632: ['Feyscale Cloak', 3, 24, 19, 4, 1, 16, { [STA]: 3, [SPI]: 2 }],
  10413: ['Gloves of the Fang', 2, 23, 18, 4, 2, 10, { [AGI]: 3 }],
};
// Items that are not equipment, read by name only.
const OTHER: Record<number, [string, number]> = {
  932: ['Fel Steed Saddlebags', 2],
  277490: ['Silverlaine Vintage', 1],
  273105: ['Recipe: Gilnean Feast', 2],
  6895: ["Jordan's Smithing Hammer", 1],
  6283: ['The Book of Ur', 1],
  6446: ['Snakeskin Bag', 2],
  10441: ['Glowing Shard', 1],
  252781: ["Pattern: Stormrider's Leather Gloves", 2],
};

// Fedrath knows staves, daggers and wands; mages can also learn one-handed
// swords, which he has not trained. Skill line by item class and subclass,
// and the subclasses mages learn, as ItemProficiencies.lua has them.
const KNOWN = new Set(['2:10', '2:15', '2:19']);
const MAGE_CAN_LEARN = new Set(['2:7', '2:10', '2:15', '2:19']);
const UNGATED = new Set(['4:0', '4:1']);

function proficiency(classID: number, subclassID: number) {
  const key = `${classID}:${subclassID}`;
  if (UNGATED.has(key) || KNOWN.has(key)) {
    return { proficiency: 'usable' };
  }
  return MAGE_CAN_LEARN.has(key)
    ? { proficiency: 'trainable', trainableAtLevel: 1 }
    : { proficiency: 'class_cannot_use' };
}

// itemId -> what the addon's gear_candidates returns for it.
export function gameItemReadings() {
  return { ...shadowfangReadings(), ...moltenCoreReadings() };
}

// Molten Core's drops, named as AtlasLoot's source comments name them, with
// Forever's item class and slot; level 60 raid gear with illustrative levels
// and no stats, so the raid eval reads names, not upgrades for a level 21.
function moltenCoreReadings() {
  const readings: Record<number, { kind: 'item' | 'other'; reading: Record<string, unknown> }> = {};
  for (const [id, [name, classID, subclassID, inventory]] of Object.entries(
    moltenCore as unknown as Record<string, [string, number, number, number]>,
  )) {
    const slot = INVENTORY[inventory];
    readings[Number(id)] =
      (classID === 2 || classID === 4) && slot
        ? {
            kind: 'item',
            reading: {
              ...candidate(item(Number(id), name, 4, 66, 60, slot, {})),
              status: 'available',
              ...proficiency(classID, subclassID),
            },
          }
        : { kind: 'other', reading: { id: Number(id), name, quality: 4 } };
  }
  return readings;
}

function shadowfangReadings() {
  const readings: Record<number, { kind: 'item' | 'other'; reading: Record<string, unknown> }> = {};
  for (const [id, row] of Object.entries(ROWS)) {
    const [name, quality, itemLevel, requiredLevel, classID, subclassID, inventory, stats] = row;
    const entry: Item = item(
      Number(id),
      name,
      quality,
      itemLevel,
      requiredLevel,
      INVENTORY[inventory]!,
      stats,
    );
    readings[Number(id)] = {
      kind: 'item',
      reading: {
        ...candidate(entry),
        status: 'available',
        ...proficiency(classID, subclassID),
      },
    };
  }
  for (const [id, [name, quality]] of Object.entries(OTHER)) {
    readings[Number(id)] = { kind: 'other', reading: { id: Number(id), name, quality } };
  }
  return readings;
}
