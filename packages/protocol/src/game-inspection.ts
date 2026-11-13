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
export const referenceInput = z.object({
  kind: z.enum(['item', 'spell', 'quest', 'talent']),
  id: z.number().int().positive(),
});
export const progressionInput = z.object({
  questIds: z.array(z.number().int().positive()).max(40).default([]),
  factionIds: z.array(z.number().int().positive()).max(20).default([]),
});
export const compareInput = z.object({
  itemIds: z.array(z.number().int().positive()).min(1).max(5),
  slot: z.number().int().min(1).max(19).optional(),
});
export const auctionInput = z.object({
  itemId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
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
  z.object({
    kind: z.literal('merchant'),
    args: z.strictObject({
      offset: z.number().int().min(0).max(500).default(0),
      limit: z.number().int().min(1).max(40).default(20),
    }),
  }),
  z.object({ kind: z.literal('training'), args: trainingInput }),
  z.object({ kind: z.literal('chat'), args: chatHistoryInput }),
  z.object({ kind: z.literal('questie_quest'), args: questInput }),
  z.object({ kind: z.literal('questie_chain'), args: questChainInput }),
  z.object({ kind: z.literal('object_locations'), args: objectLocationsInput }),
  z.object({ kind: z.literal('stored_item'), args: storedItemInput }),
  z.object({ kind: z.literal('item_prices'), args: itemPricesInput }),
  z.object({ kind: z.literal('npc_locations'), args: npcLocationsInput }),
  z.object({ kind: z.literal('settings'), args: settingsRead }),
  z.object({ kind: z.literal('reference'), args: referenceInput }),
  z.object({ kind: z.literal('progression'), args: progressionInput }),
  z.object({ kind: z.literal('compare_items'), args: compareInput }),
  z.object({ kind: z.literal('auctions'), args: auctionInput }),
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
  ...(['target', 'trainer', 'resources'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), args: z.object({}) }),
  ),
]);
