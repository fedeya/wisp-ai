// @effect-migrated
import { Schema } from 'effect';
import { rejectUnknownKeys, TrimmedString } from '@wisp/protocol/checks';
import { settingsRead } from './settings.ts';
import {
  IntBetween,
  LimitedString,
  NoArgs,
  NoArgsStrict,
  PositiveInt,
  refine,
  withDefault,
} from './tool-inputs.ts';

// An input marked strict rejects unknown keys: decode it with `rejectUnknownKeys`.

const Ids = (maxItems: number) => Schema.Array(PositiveInt).check(Schema.isMaxLength(maxItems));
const SomeIds = (maxItems: number) =>
  Schema.Array(PositiveInt).check(Schema.isMinLength(1), Schema.isMaxLength(maxItems));

export const characterSections = Schema.Array(
  Schema.Literals([
    'character',
    'location',
    'group',
    'talents',
    'spells',
    'quests',
    'gear',
    'bags',
    'pvp',
  ]),
).check(Schema.isMinLength(1), Schema.isMaxLength(9));

// Strict.
export const npcLocationsInput = Schema.Struct({
  mode: withDefault(Schema.Literals(['npc', 'class_trainers', 'services']), () => 'npc' as const),
  service: Schema.optionalKey(
    Schema.Literals([
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
    ]),
  ),
  npcId: Schema.optionalKey(PositiveInt),
  name: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 80 })),
  class: Schema.optionalKey(
    Schema.Literals([
      'MAGE',
      'WARRIOR',
      'PALADIN',
      'HUNTER',
      'ROGUE',
      'PRIEST',
      'SHAMAN',
      'WARLOCK',
      'DRUID',
    ]),
  ),
  mapId: Schema.optionalKey(PositiveInt),
  limit: withDefault(IntBetween(1, 10), () => 5),
}).check(
  refine(
    (x) =>
      x.mode === 'services'
        ? x.service !== undefined
        : x.mode === 'class_trainers' || x.npcId !== undefined || x.name !== undefined,
    'Provide a service in services mode, an NPC name/ID, or class_trainers mode',
  ),
);
// Strict.
export const questInput = Schema.Struct({ questId: PositiveInt });
// Strict.
export const questChainInput = Schema.Struct({
  questId: PositiveInt,
  direction: withDefault(
    Schema.Literals(['prerequisites', 'followups', 'both']),
    () => 'both' as const,
  ),
  maxDepth: withDefault(IntBetween(1, 4), () => 2),
  limit: withDefault(IntBetween(1, 30), () => 15),
});
// Strict.
export const objectLocationsInput = Schema.Struct({
  objectId: Schema.optionalKey(PositiveInt),
  name: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 80 })),
  mapId: Schema.optionalKey(PositiveInt),
  limit: withDefault(IntBetween(1, 10), () => 5),
}).check(
  refine(
    (args) => args.objectId !== undefined || args.name !== undefined,
    'Provide an object ID or exact localized name',
  ),
);
// Strict.
export const storedItemInput = Schema.Struct({
  itemId: PositiveInt,
  includeGuild: withDefault(Schema.Boolean, () => false),
  limit: withDefault(IntBetween(1, 40), () => 20),
});
// Strict.
export const itemPricesInput = Schema.Struct({ itemIds: SomeIds(20) });
// Strict.
export const polestarGuideInput = Schema.Struct({
  upcoming: withDefault(
    IntBetween(0, 5).annotate({ description: 'How many steps after the current one to include.' }),
    () => 2,
  ),
});
export const referenceInput = Schema.Struct({
  kind: Schema.Literals(['item', 'spell', 'quest', 'talent']),
  id: PositiveInt,
  includeCooldown: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Read the current timer for an item or spell.' }),
  ),
}).check(
  refine(
    (args) => !args.includeCooldown || args.kind === 'item' || args.kind === 'spell',
    'Cooldowns require kind=item or kind=spell',
  ),
);
export const progressionInput = Schema.Struct({
  questIds: withDefault(Ids(40), () => []),
  factionIds: withDefault(Ids(20), () => []),
});
export const compareInput = Schema.Struct({
  itemIds: SomeIds(5),
  slot: Schema.optionalKey(IntBetween(1, 19)),
});
const gearLevels = {
  minRequiredLevel: Schema.optionalKey(IntBetween(0, 100)),
  maxRequiredLevel: Schema.optionalKey(
    IntBetween(1, 100).annotate({
      description: 'Highest required level to keep; defaults to the character level.',
    }),
  ),
  quality: withDefault(
    Schema.Array(Schema.Literals(['poor', 'common', 'uncommon', 'rare', 'epic']))
      .check(Schema.isMinLength(1), Schema.isMaxLength(5))
      .annotate({ description: 'Item qualities to search.' }),
    () => ['common', 'uncommon', 'rare'] as const,
  ),
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
// Strict.
export const armorSearchInput = Schema.Struct({
  slot: Schema.Literals(armorSlots),
  armorType: Schema.optionalKey(
    Schema.Literals(['cloth', 'leather', 'mail', 'plate']).annotate({
      description: 'Required for body slots; ignored for neck, finger, trinket and back.',
    }),
  ),
  ...gearLevels,
}).check(
  refine(
    (args) => typelessArmorSlots.includes(args.slot) || args.armorType !== undefined,
    'armorType is required for this slot',
  ),
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
// Strict.
export const weaponSearchInput = Schema.Struct({
  weaponType: Schema.Literals(weaponTypes),
  ...gearLevels,
});
// Strict.
export const itemSourcesInput = Schema.Struct({ itemIds: SomeIds(20) });
// Bridge-to-addon only: names for source entities plus cached prices. Strict.
export const sourceNamesInput = Schema.Struct({
  itemIds: Ids(20),
  npcIds: Ids(200),
  questIds: Ids(200),
  spellIds: Ids(200),
  useQuestie: Schema.Boolean,
});
// Internal item reading used after a tool resolves catalog IDs. Strict. No
// model reads it, so its optional keys also take `undefined`, as zod's did.
export const gearCandidatesInput = Schema.Struct({
  itemIds: SomeIds(500),
  minRequiredLevel: Schema.optional(IntBetween(0, 100)),
  maxRequiredLevel: Schema.optional(IntBetween(1, 100)),
  // Also name the items that are not equipment (recipes, quest items).
  includeOther: Schema.optional(Schema.Boolean),
});
// Strict.
export const dungeonLootInput = Schema.Struct({
  instanceMapId: Schema.optionalKey(
    PositiveInt.annotate({ description: 'instanceMapId from wow__query_dungeons; preferred.' }),
  ),
  dungeon: Schema.optionalKey(
    TrimmedString({ minLength: 1, maxLength: 80 }).pipe(
      Schema.annotateEncoded({
        description: 'Part of the English instance name, when no instanceMapId is known.',
      }),
    ),
  ),
  boss: Schema.optionalKey(
    TrimmedString({ minLength: 1, maxLength: 80 }).pipe(
      Schema.annotateEncoded({
        description: 'Part of an English boss name, to read one boss.',
      }),
    ),
  ),
  detail: Schema.optionalKey(
    Schema.Literals(['summary', 'full']).annotate({
      description:
        'summary: every drop per boss with name, drop chance and required level, plus item level gain and stat changes for upgrades; full: also the stats of every item and the equipped item. Default: full with boss, summary without. A full answer too large for one read comes back as the summary.',
    }),
  ),
  includeUnusable: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Also list weapons and armor this character's class can never use. Leave it unset for the player's own gear; set it only for loot for another class.",
    }),
  ),
}).check(
  refine(
    (args) => args.instanceMapId !== undefined || args.dungeon !== undefined,
    'Give instanceMapId or dungeon',
  ),
);
export const auctionInput = Schema.Struct({
  itemId: Schema.optionalKey(PositiveInt),
  limit: withDefault(IntBetween(1, 50), () => 20),
});
// Strict.
export const dungeonsInput = Schema.Struct({
  dungeon: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 80 })),
});
// Strict.
export const flightPathsInput = Schema.Struct({
  origin: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 120 })),
  destination: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 120 })),
  limit: withDefault(IntBetween(1, 40), () => 20),
});
// Strict.
export const chatHistoryInput = Schema.Struct({
  channels: withDefault(
    Schema.Array(
      Schema.Literals([
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
    ).check(Schema.isMaxLength(9)),
    () => [],
  ),
  limit: withDefault(IntBetween(1, 50), () => 30),
  lastSeconds: withDefault(IntBetween(1, 1800), () => 1800),
  sender: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 120 })),
  query: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 200 })),
  channelName: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 120 })),
  channelIndex: Schema.optionalKey(IntBetween(1, 99)),
});
// `deaths` reads the game's Death Recap for the player's latest deaths (and,
// optionally, group deaths); `fight` reads the game's damage meter. Strict.
export const combatInput = Schema.Struct({
  view: withDefault(Schema.Literals(['deaths', 'fight']), () => 'deaths' as const),
  deaths: withDefault(IntBetween(1, 5), () => 1),
  includeGroup: withDefault(Schema.Boolean, () => false),
  eventLimit: withDefault(IntBetween(1, 30), () => 20),
});
export const trainingInput = Schema.Struct({
  class: Schema.optionalKey(
    Schema.Literals([
      'DRUID',
      'HUNTER',
      'MAGE',
      'PALADIN',
      'PRIEST',
      'ROGUE',
      'SHAMAN',
      'WARLOCK',
      'WARRIOR',
    ]),
  ),
  query: Schema.optionalKey(TrimmedString({ minLength: 1, maxLength: 80 })),
  spellId: Schema.optionalKey(PositiveInt),
  minLevel: withDefault(IntBetween(0, 60), () => 0),
  maxLevel: withDefault(IntBetween(0, 60), () => 60),
  offset: withDefault(IntBetween(0, 5000), () => 0),
  limit: withDefault(IntBetween(1, 100), () => 30),
}).check(refine((input) => input.minLevel <= input.maxLevel, 'Invalid level range'));
export const macrosInput = Schema.Struct({
  names: withDefault(Schema.Array(LimitedString(1, 32)).check(Schema.isMaxLength(10)), () => []),
  includeBodies: withDefault(Schema.Boolean, () => false),
});
export const mapInput = Schema.Struct({
  mapIds: withDefault(Ids(20), () => []),
  query: Schema.optionalKey(LimitedString(1, 80)),
});

const inspection = <const K extends string, A extends Schema.Top>(kind: K, args: A) =>
  Schema.Struct({ kind: Schema.Literal(kind), args });

export const gearSearchInspectionSchema = Schema.Union([
  inspection('search_armor', armorSearchInput),
  inspection('search_weapons', weaponSearchInput),
]);

export const inspectionSchema = Schema.Union([
  inspection('training', trainingInput),
  inspection('chat', chatHistoryInput),
  inspection('combat', combatInput),
  inspection('questie_quest', questInput),
  inspection('questie_chain', questChainInput),
  inspection('object_locations', objectLocationsInput),
  inspection('stored_item', storedItemInput),
  inspection('item_prices', itemPricesInput),
  inspection('polestar_guide', polestarGuideInput),
  inspection('npc_locations', npcLocationsInput),
  inspection('settings', settingsRead),
  inspection('reference', referenceInput),
  inspection('progression', progressionInput),
  inspection('compare_items', compareInput),
  ...gearSearchInspectionSchema.members,
  inspection('gear_candidates', gearCandidatesInput),
  inspection('auctions', auctionInput),
  inspection('flight_paths', flightPathsInput),
  inspection('dungeons', dungeonsInput),
  inspection('macros', macrosInput),
  inspection('map', mapInput),
  inspection('hearthstone', NoArgsStrict),
  inspection('target', NoArgs),
  inspection('trainer', NoArgs),
  inspection('resources', NoArgs),
]);

type InspectionKind = (typeof inspectionSchema.Encoded)['kind'];

// Whether each inspection's arguments reject unknown keys.
const strictArgs = {
  training: false,
  chat: true,
  combat: true,
  questie_quest: true,
  questie_chain: true,
  object_locations: true,
  stored_item: true,
  item_prices: true,
  polestar_guide: true,
  npc_locations: true,
  settings: false,
  reference: false,
  progression: false,
  compare_items: false,
  search_armor: true,
  search_weapons: true,
  gear_candidates: true,
  auctions: false,
  flight_paths: true,
  dungeons: true,
  macros: false,
  map: false,
  hearthstone: true,
  target: false,
  trainer: false,
  resources: false,
} satisfies Record<InspectionKind, boolean>;

/**
 * How to decode an inspection of `kind`: with `rejectUnknownKeys` when its
 * arguments are strict, which also closes the `{ kind, args }` envelope.
 */
export const inspectionParseOptions = (kind: InspectionKind) =>
  strictArgs[kind] ? rejectUnknownKeys : undefined;
