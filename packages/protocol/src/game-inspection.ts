import { z } from 'zod';
import { settingsRead } from './settings.ts';
export const npcLocationsInput = z
  .strictObject({
    mode: z.enum(['npc', 'class_trainers', 'services']).default('npc'),
    service: z
      .enum([
        'Transmogrifier',
        'Barber',
        'Banker',
        'Auctioneer',
        'Innkeeper',
        'Flight Master',
        'Repair',
        'Battlemaster',
        'Arcane Reforger',
        'Weapon Master',
      ])
      .optional(),
    npcId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    class: z
      .enum([
        'MAGE',
        'WARRIOR',
        'PALADIN',
        'HUNTER',
        'ROGUE',
        'PRIEST',
        'SHAMAN',
        'WARLOCK',
        'DRUID',
      ])
      .optional(),
    mapId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .refine(
    (x) =>
      x.mode === 'services'
        ? x.service !== undefined
        : x.mode === 'class_trainers' || x.npcId !== undefined || x.name !== undefined,
    'Provide a service in services mode, an NPC name/ID, or class_trainers mode',
  );
export const questInput = z.strictObject({ questId: z.number().int().positive() });
export const questChainInput = z.strictObject({
  questId: z.number().int().positive(),
  direction: z.enum(['prerequisites', 'followups', 'both']).default('both'),
  maxDepth: z.number().int().min(1).max(4).default(2),
  limit: z.number().int().min(1).max(30).default(15),
});
export const objectLocationsInput = z
  .strictObject({
    objectId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    mapId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .refine(
    (args) => args.objectId !== undefined || args.name !== undefined,
    'Provide an object ID or exact localized name',
  );
export const storedItemInput = z.strictObject({
  itemId: z.number().int().positive(),
  includeGuild: z.boolean().default(false),
  limit: z.number().int().min(1).max(40).default(20),
});
export const itemPricesInput = z.strictObject({
  itemIds: z.array(z.number().int().positive()).min(1).max(20),
});
export const polestarGuideInput = z.strictObject({
  upcoming: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(2)
    .describe('How many steps after the current one to include.'),
});
export const referenceInput = z
  .object({
    kind: z.enum(['item', 'spell', 'quest', 'talent']),
    id: z.number().int().positive(),
    includeCooldown: z
      .boolean()
      .optional()
      .describe('Read the current timer for an item or spell.'),
  })
  .refine(
    (args) => !args.includeCooldown || args.kind === 'item' || args.kind === 'spell',
    'Cooldowns require kind=item or kind=spell',
  );
export const progressionInput = z.object({
  questIds: z.array(z.number().int().positive()).max(40).default([]),
  factionIds: z.array(z.number().int().positive()).max(20).default([]),
});
export const compareInput = z.object({
  itemIds: z.array(z.number().int().positive()).min(1).max(5),
  slot: z.number().int().min(1).max(19).optional(),
});
const gearLevels = {
  minRequiredLevel: z.number().int().min(0).max(100).optional(),
  maxRequiredLevel: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Highest required level to keep; defaults to the character level.'),
  quality: z
    .array(z.enum(['poor', 'common', 'uncommon', 'rare', 'epic']))
    .min(1)
    .max(5)
    .default(['common', 'uncommon', 'rare'])
    .describe('Item qualities to search.'),
};
export const armorSlots = [
  'head',
  'neck',
  'shoulder',
  'back',
  'chest',
  'wrist',
  'hands',
  'waist',
  'legs',
  'feet',
  'finger',
  'trinket',
] as const;
// Jewelry, trinkets and cloaks have no armor type of their own.
export const typelessArmorSlots: readonly string[] = ['neck', 'finger', 'trinket', 'back'];
export const armorSearchInput = z
  .strictObject({
    slot: z.enum(armorSlots),
    armorType: z
      .enum(['cloth', 'leather', 'mail', 'plate'])
      .optional()
      .describe('Required for body slots; ignored for neck, finger, trinket and back.'),
    ...gearLevels,
  })
  .refine(
    (args) => typelessArmorSlots.includes(args.slot) || args.armorType !== undefined,
    'armorType is required for this slot',
  );
export const weaponTypes = [
  'staves',
  'wands',
  'daggers',
  'one-handed-swords',
  'two-handed-swords',
  'one-handed-maces',
  'two-handed-maces',
  'one-handed-axes',
  'two-handed-axes',
  'polearms',
  'fist-weapons',
  'bows',
  'guns',
  'crossbows',
  'thrown',
  'shields',
  'held-in-off-hand',
] as const;
export const weaponSearchInput = z.strictObject({
  weaponType: z.enum(weaponTypes),
  ...gearLevels,
});
export const itemSourcesInput = z.strictObject({
  itemIds: z.array(z.number().int().positive()).min(1).max(20),
});
// Bridge-to-addon only: names for source entities plus cached prices.
export const sourceNamesInput = z.strictObject({
  itemIds: z.array(z.number().int().positive()).max(20),
  npcIds: z.array(z.number().int().positive()).max(200),
  questIds: z.array(z.number().int().positive()).max(200),
  spellIds: z.array(z.number().int().positive()).max(200),
  useQuestie: z.boolean(),
});
// Bridge-to-addon only: the bridge resolves catalog IDs before the game read.
export const gearCandidatesInput = z.strictObject({
  itemIds: z.array(z.number().int().positive()).min(1).max(500),
  minRequiredLevel: z.number().int().min(0).max(100).optional(),
  maxRequiredLevel: z.number().int().min(1).max(100).optional(),
});
export const auctionInput = z.object({
  itemId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const dungeonsInput = z.strictObject({
  dungeon: z.string().trim().min(1).max(80).optional(),
});
export const flightPathsInput = z.strictObject({
  origin: z.string().trim().min(1).max(120).optional(),
  destination: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(40).default(20),
});
export const chatHistoryInput = z.strictObject({
  channels: z
    .array(
      z.enum([
        'say',
        'yell',
        'party',
        'raid',
        'instance',
        'guild',
        'officer',
        'whisper',
        'channel',
      ]),
    )
    .max(9)
    .default([]),
  limit: z.number().int().min(1).max(50).default(30),
  lastSeconds: z.number().int().min(1).max(1800).default(1800),
  sender: z.string().trim().min(1).max(120).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  channelName: z.string().trim().min(1).max(120).optional(),
  channelIndex: z.number().int().min(1).max(99).optional(),
});
// `deaths` reads the game's Death Recap for the player's latest deaths (and,
// optionally, group deaths); `fight` reads the game's damage meter.
export const combatInput = z.strictObject({
  view: z.enum(['deaths', 'fight']).default('deaths'),
  deaths: z.number().int().min(1).max(5).default(1),
  includeGroup: z.boolean().default(false),
  eventLimit: z.number().int().min(1).max(30).default(20),
});
export const trainingInput = z
  .object({
    class: z
      .enum([
        'DRUID',
        'HUNTER',
        'MAGE',
        'PALADIN',
        'PRIEST',
        'ROGUE',
        'SHAMAN',
        'WARLOCK',
        'WARRIOR',
      ])
      .optional(),
    query: z.string().trim().min(1).max(80).optional(),
    spellId: z.number().int().positive().optional(),
    minLevel: z.number().int().min(0).max(60).default(0),
    maxLevel: z.number().int().min(0).max(60).default(60),
    offset: z.number().int().min(0).max(5000).default(0),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .refine((input) => input.minLevel <= input.maxLevel, 'Invalid level range');
export const inspectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('training'), args: trainingInput }),
  z.object({ kind: z.literal('chat'), args: chatHistoryInput }),
  z.object({ kind: z.literal('combat'), args: combatInput }),
  z.object({ kind: z.literal('questie_quest'), args: questInput }),
  z.object({ kind: z.literal('questie_chain'), args: questChainInput }),
  z.object({ kind: z.literal('object_locations'), args: objectLocationsInput }),
  z.object({ kind: z.literal('stored_item'), args: storedItemInput }),
  z.object({ kind: z.literal('item_prices'), args: itemPricesInput }),
  z.object({ kind: z.literal('polestar_guide'), args: polestarGuideInput }),
  z.object({ kind: z.literal('npc_locations'), args: npcLocationsInput }),
  z.object({ kind: z.literal('settings'), args: settingsRead }),
  z.object({ kind: z.literal('reference'), args: referenceInput }),
  z.object({ kind: z.literal('progression'), args: progressionInput }),
  z.object({ kind: z.literal('compare_items'), args: compareInput }),
  z.object({ kind: z.literal('search_armor'), args: armorSearchInput }),
  z.object({ kind: z.literal('search_weapons'), args: weaponSearchInput }),
  z.object({ kind: z.literal('item_sources'), args: itemSourcesInput }),
  z.object({ kind: z.literal('auctions'), args: auctionInput }),
  z.object({ kind: z.literal('flight_paths'), args: flightPathsInput }),
  z.object({ kind: z.literal('dungeons'), args: dungeonsInput }),
  z.object({
    kind: z.literal('macros'),
    args: z.object({
      names: z.array(z.string().min(1).max(32)).max(10).default([]),
      includeBodies: z.boolean().default(false),
    }),
  }),
  z.object({
    kind: z.literal('map'),
    args: z.object({
      mapIds: z.array(z.number().int().positive()).max(20).default([]),
      query: z.string().min(1).max(80).optional(),
    }),
  }),
  z.object({ kind: z.literal('hearthstone'), args: z.strictObject({}) }),
  ...(['target', 'trainer', 'resources'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), args: z.object({}) }),
  ),
]);
