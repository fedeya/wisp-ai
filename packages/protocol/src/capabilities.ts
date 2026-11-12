import { z } from 'zod';
export const capabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  group: z.enum(['core', 'integrations', 'memory']),
  kind: z.enum(['game', 'addon', 'source', 'service', 'mcp']).optional(),
  toolName: z.string().optional(),
  description: z.string(),
  parent: z.string().optional(),
  defaultEnabled: z.boolean().optional(),
});
export type Capability = z.infer<typeof capabilitySchema>;
export const everlootTools = [
  'search_knowledge',
  'item_page',
  'npc_page',
  'object_page',
  'quest_page',
  'vendor_page',
  'world_map_near',
  'entity_relations',
  'item_categories',
  'talent_tree',
  'talent_plan',
  'class_races',
  'profession_path',
  'recipe_thresholds',
  'market_value',
  'auction_history',
  'coverage',
  'recent_changes',
];
const everlootDescriptions: Record<string, [string, string]> = {
  search_knowledge: ['Search Everloot', 'Search Forever game information.'],
  item_page: ['Item details', 'Look up an item in Everloot.'],
  npc_page: ['NPC details', 'Look up an NPC in Everloot.'],
  object_page: ['Object details', 'Look up a world object in Everloot.'],
  quest_page: ['Quest details', 'Look up a quest in Everloot.'],
  vendor_page: ['Vendor details', 'Look up a vendor and their stock.'],
  world_map_near: ['Nearby locations', 'Find locations near a point on the map.'],
  entity_relations: [
    'Related game data',
    'Find connections between items, NPCs, objects and quests.',
  ],
  item_categories: ['Item categories', 'Browse categories of items.'],
  talent_tree: ['Talent trees', 'Look up a class’s talent trees.'],
  talent_plan: ['Talent plans', 'Look up talent build information.'],
  class_races: ['Classes and races', 'Look up which races can play a class.'],
  profession_path: ['Profession leveling', 'Look up progression information for a profession.'],
  recipe_thresholds: [
    'Recipe skill levels',
    'Look up the skill levels at which recipes change difficulty.',
  ],
  market_value: ['Market prices', 'Look up recorded market prices.'],
  auction_history: ['Auction history', 'Look up past auction observations.'],
  coverage: ['Data coverage', 'Check which game data Everloot has.'],
  recent_changes: ['Game updates', 'Look up recent Forever changes.'],
};
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
    'Read your talents, learned spells, quests, equipment and bags.',
  ],
  inspect_reference: [
    'Inspect references',
    'Read item, spell, talent and quest details from the game.',
  ],
  query_progression: [
    'Quest progression',
    'Read active and completed quests, and your reputations.',
  ],
  inspect_pet: [
    'Inspect pet',
    'Read your active owned pet, learned abilities and pet-bar autocast states.',
  ],
  inspect_target: ['Inspect target', 'Read the selected NPC or enemy.'],
  read_chat: [
    'Read WoW chat',
    'Read recent messages from the game chat channels enabled in Wisp settings.',
  ],
  query_training: [
    'Ability catalog',
    'Look up Forever class abilities, levels, base prices and requirements without visiting a trainer.',
  ],
  inspect_trainer: ['Inspect trainer', 'Read offers from the trainer window currently open.'],
  inspect_merchant: [
    'Inspect merchant',
    'Read bounded offers and bundle prices from the currently open merchant; never purchases.',
  ],
  compare_items: ['Compare equipment', 'Compare item stats with current equipment.'],
  inspect_quest_rewards: [
    'Read current quest rewards',
    'Read the open turn-in dialog’s guaranteed rewards and alternatives with exact item links and cached stats. Never selects or claims rewards.',
  ],
  query_resources: ['Read resources', 'Read money, bag contents, free space and skill ranks.'],
  inspect_auctions: [
    'Read auction results',
    'Read the auction results currently loaded in the auction house.',
  ],
  inspect_macros: [
    'Read macros',
    'List your macros and free slots, and read macro contents when requested.',
  ],
  inspect_map: ['Read maps', 'Look up maps and read your current map pin.'],
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
export const capabilityViewSchema = capabilitySchema.extend({
  enabled: z.boolean(),
  effective: z.boolean(),
  available: z.boolean(),
  status: z.string(),
  reason: z.string().optional(),
  version: z.string().optional(),
});
export type CapabilityView = z.infer<typeof capabilityViewSchema>;
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
    {
      id: 'mcp:everloot',
      name: 'Everloot',
      group: 'integrations',
      kind: 'mcp',
      description: 'Look up Forever drops, vendors, professions and market history.',
    },
    ...everlootTools.map((name) => ({
      id: 'mcp_tool:everloot:' + name,
      name: everlootDescriptions[name][0],
      toolName: name,
      group: 'integrations' as const,
      parent: 'mcp:everloot',
      description: everlootDescriptions[name][1],
    })),
  ];
}

// Compact, authoritative availability for this turn; never addon descriptions or instructions.
export function integrationContext(entries: CapabilityView[]) {
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
