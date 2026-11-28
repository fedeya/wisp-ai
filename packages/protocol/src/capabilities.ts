// @effect-migrated
import { Schema, Struct } from 'effect';
import type { FeatureFlag } from './features.js';
export const capabilitySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  group: Schema.Literals(['core', 'integrations', 'memory']),
  kind: Schema.optional(Schema.Literals(['game', 'addon', 'source', 'service', 'mcp'])),
  toolName: Schema.optional(Schema.String),
  description: Schema.String,
  parent: Schema.optional(Schema.String),
  defaultEnabled: Schema.optional(Schema.Boolean),
});
export type Capability = typeof capabilitySchema.Type;
export const toolDescriptions: Record<string, [string, string]> = {
  manage_routine: [
    'Routines',
    'Create and manage character routines triggered by game events or intervals.',
  ],
  get_quest: [
    'Read quest details',
    'Look up quest objectives, where to start and finish, and requirements.',
  ],
  get_quest_chain: ['Read quest chain', 'Find which quests come before and after a quest.'],
  find_object_locations: ['Find object locations', 'Find quest objects on the map.'],
  find_item: [
    'Find stored items',
    'Find saved item counts across characters on your connected realm and faction. Guild storage is optional.',
  ],
  get_item_prices: [
    'Read cached auction prices',
    'Look up the last recorded price per item and when it was seen.',
  ],
  get_guide_step: [
    'Read guide step',
    'See the Polestar guide you are following, your current step and what comes next.',
  ],
  create_guide: [
    'Create guides',
    'Build a step-by-step guide and open it in Polestar, which tracks it and points the way.',
  ],
  find_npc_locations: [
    'Find NPC locations',
    'Find NPCs, class trainers and city services on the map.',
  ],
  simulate_dps: [
    'Simulate DPS',
    'Compare damage plans and equipment for all nine classes, levels 1–60. Experimental; supported abilities only.',
  ],
  search_database: [
    'Search Forever database',
    'Search Forever items, spells, quests, NPCs and zones.',
  ],
  get_database_entity: [
    'Read Forever database',
    'Look up details about an item, spell, quest, NPC or zone.',
  ],
  manage_panel: [
    'Persistent panels',
    'Create and manage trackers for items, money, levels and quests.',
  ],
  get_settings: [
    'Read settings',
    'Read game and supported addon settings, action bars and keybindings.',
  ],
  update_settings: [
    'Change settings',
    'Preview and apply changes to game and supported addon settings.',
  ],
  undo_settings: [
    'Undo settings',
    'Undo settings changes made by Wisp, keeping any changes you made afterward.',
  ],
  query_character: [
    'Character readings',
    'Read your talents, learned spells, quests, equipment, bags, group and PvP rank and honor.',
  ],
  inspect_reference: [
    'Inspect references',
    'Read item, spell, talent and quest details from the game.',
  ],
  query_progression: [
    'Quest progression',
    'Read active and completed quests, and your reputations.',
  ],
  inspect_target: ['Inspect target', 'Read the selected NPC or enemy.'],
  read_chat: [
    'Read WoW chat',
    'Read recent messages from the game chat channels enabled in Wisp settings.',
  ],
  read_combat: [
    'Read deaths and fights',
    'Read the game’s Death Recap for your last deaths and the damage meter for your last fight.',
  ],
  query_training: [
    'Ability catalog',
    'Look up Forever class abilities, levels, base prices and requirements without visiting a trainer.',
  ],
  inspect_trainer: ['Inspect trainer', 'Read offers from the trainer window currently open.'],
  compare_items: ['Compare equipment', 'Compare item stats with current equipment.'],
  search_armor: ['Search armor', 'List armor and jewelry for a slot that fits your level.'],
  item_sources: ['Find item sources', 'Read where items come from and their last auction price.'],
  dungeon_loot: [
    'Dungeon loot',
    'Read what each dungeon and raid boss drops, with drop chances, compared with your equipment.',
  ],
  search_weapons: ['Search weapons', 'List weapons, shields and off-hands that fit your level.'],
  query_resources: ['Read resources', 'Read money, bag contents, free space and skill ranks.'],
  inspect_auctions: [
    'Read auction results',
    'Read the auction results currently loaded in the auction house.',
  ],
  inspect_macros: [
    'Read macros',
    'List your macros and free slots, and read macro contents when requested.',
  ],
  inspect_flight_paths: [
    'Read flight paths',
    'Find flight points on the world map and read routes from the flight master maps your character has opened.',
  ],
  query_dungeons: [
    'Dungeon journal',
    'Read Forever dungeons, their level ranges and entrances from the game.',
  ],
  inspect_map: ['Read maps', 'Look up maps and read your current map pin.'],
  inspect_hearthstone: ['Read Hearthstone bind', 'Read where your Hearthstone takes you.'],
  set_map_waypoint: [
    'Mark map',
    'Place a map pin and show directions when navigation is available.',
  ],
  clear_map_waypoint: ['Undo map marker', 'Remove Wisp’s marker and restore the prior pin.'],
  create_macro: ['Create macros', 'Create new macros outside combat. Existing macros are kept.'],
  web_search: [
    'Web search',
    'Search globally across the public web for guides, addon sources and reference information.',
  ],
  web_fetch: ['Read web pages', 'Open a public HTTPS URL and read its content without a browser.'],
  set_conversation_title: ['Conversation titles', 'Name conversations based on what you discuss.'],
};

export const coreCapabilities: Capability[] = [
  {
    id: 'core:wow',
    name: 'World of Warcraft',
    group: 'core',
    kind: 'game',
    description: 'Read your character’s state, mark the map, create macros and adjust settings.',
  },
  {
    id: 'core:wisp',
    name: 'Wisp',
    group: 'core',
    kind: 'service',
    description: 'Conversation titles and saved trackers.',
  },
];

export const integrations: Capability[] = [
  {
    id: 'integration:web',
    name: 'Web search and pages',
    group: 'integrations',
    kind: 'source',
    description: 'Search globally across the public web and read pages by URL.',
  },
  {
    id: 'integration:syndicator',
    name: 'Syndicator',
    group: 'integrations',
    kind: 'addon',
    description: 'Find items across characters, banks, mail and guild storage.',
  },
  {
    id: 'integration:auctionator',
    name: 'Auctionator',
    group: 'integrations',
    kind: 'addon',
    description: 'Look up saved auction prices on your realm and when they were recorded.',
  },
  {
    id: 'integration:polestar',
    name: 'Polestar',
    group: 'integrations',
    kind: 'addon',
    description:
      'Know which guide you are following and your current step, and get custom guides built for you.',
  },
  {
    id: 'integration:questie',
    name: 'Questie',
    group: 'integrations',
    kind: 'addon',
    description: 'Look up quests, follow quest chains and find NPCs and objects on the map.',
  },
  {
    id: 'integration:thewowdb',
    name: 'TheWoWDB',
    group: 'integrations',
    kind: 'source',
    description: 'Look up Forever items, spells, quests, NPCs and zones.',
  },
  {
    id: 'integration:wowsims',
    name: 'WoWSims Forever',
    group: 'integrations',
    kind: 'service',
    description:
      'Compare class damage plans and equipment at levels 1–60. Experimental; no pets, healing or tanking.',
  },
];
export function toolIntegration(name: string): string {
  if (name === 'web_fetch') {
    return 'web';
  }
  if (
    ['find_npc_locations', 'get_quest', 'get_quest_chain', 'find_object_locations'].includes(name)
  ) {
    return 'questie';
  }
  if (name === 'find_item') {
    return 'syndicator';
  }
  if (name === 'get_item_prices') {
    return 'auctionator';
  }
  if (name === 'get_guide_step' || name === 'create_guide') {
    return 'polestar';
  }
  if (['search_database', 'get_database_entity'].includes(name)) {
    return 'thewowdb';
  }
  if (name === 'web_search') {
    return 'web';
  }
  if (name === 'simulate_dps') {
    return 'wowsims';
  }
  if (['manage_panel', 'manage_routine', 'set_conversation_title'].includes(name)) {
    return 'wisp';
  }
  return 'wow';
}
export function publicToolName(name: string): string {
  if (name === 'web_fetch') {
    return name;
  }
  return toolIntegration(name) + '__' + name;
}
export const capabilityViewSchema = capabilitySchema.mapFields(
  Struct.assign({
    enabled: Schema.Boolean,
    effective: Schema.Boolean,
    available: Schema.Boolean,
    status: Schema.String,
    reason: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
  }),
);
export type CapabilityView = typeof capabilityViewSchema.Type;
/**
 * Tools that exist only while a feature flag is on, keyed by their
 * `toolDescriptions` name. With the flag off, the bridge leaves the tool out of
 * every capability list and tells the agent it is disabled.
 */
export const toolFeatures: Readonly<Record<string, FeatureFlag>> = {};
export function defaultCapabilities(): Capability[] {
  const tools = Object.entries(toolDescriptions).map(([name, [label, description]]) => ({
    id: 'tool:' + name,
    name: label,
    group: ['wow', 'wisp'].includes(toolIntegration(name))
      ? ('core' as const)
      : ('integrations' as const),
    parent:
      (['wow', 'wisp'].includes(toolIntegration(name)) ? 'core:' : 'integration:') +
      toolIntegration(name),
    toolName: publicToolName(name),
    description,
  }));
  return [
    ...[...coreCapabilities, ...integrations].flatMap((entry) => [
      entry,
      ...tools.filter((tool) => tool.parent === entry.id),
    ]),
    {
      id: 'memory:preferences',
      name: 'Player preferences',
      group: 'memory',
      description:
        'Remember your preferences across characters. Turning this off keeps your saved notes.',
    },
    {
      id: 'memory:character',
      name: 'Character plans',
      group: 'memory',
      description:
        'Remember the guide and goals you’re following with this character. Turning this off keeps your saved notes.',
    },
  ];
}

// Compact, authoritative availability for this turn; never addon descriptions or instructions.
export function integrationContext(entries: readonly CapabilityView[]) {
  return entries
    .filter((entry) => entry.group === 'integrations' && !entry.parent)
    .map((entry) => ({
      id: entry.id,
      enabled: entry.enabled,
      available: entry.available,
      status: entry.status,
      unavailableTools: entries
        .filter((tool) => tool.parent === entry.id && !tool.available)
        .map((tool) => tool.toolName || tool.id),
      disabledTools: entries
        .filter((tool) => tool.parent === entry.id && !tool.enabled)
        .map((tool) => tool.toolName || tool.id),
    }));
}
