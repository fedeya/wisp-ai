import { Effect, Schema } from 'effect';
import type { Capability } from '@wisp/protocol/capabilities';
import type { BundledMcp, McpManager } from './mcp-manager.ts';

export const name = 'everloot';
const description = 'Look up Forever drops, vendors, professions and market history.';

const toolDescriptions: Record<string, [string, string]> = {
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

export const capabilities: readonly Capability[] = [
  { id: `mcp:${name}`, name: 'Everloot', group: 'integrations', kind: 'mcp', description },
  ...Object.entries(toolDescriptions).map(([tool, [label, description]]) => ({
    id: `mcp_tool:${name}:${tool}`,
    name: label,
    toolName: tool,
    group: 'integrations' as const,
    parent: `mcp:${name}`,
    description,
  })),
];

export const profile = {
  definition: {
    name,
    description: 'Everloot',
    url: 'https://everloot.app/mcp/public',
    transport: 'http',
    enabled: true,
    args: [],
  },
  redirect: 'error',
  toolsTtl: '5 minutes',
  callTimeoutMs: 120_000,
  trustedReadOnly: true,
  capabilities,
  toolGroups: [
    {
      namespace: name,
      description:
        'Complementary Forever-only observations and reference pages: drops, vendors, quest relations, world locations, talents, professions and realm scan history. Use TheWoWDB for the primary catalog. Missing coverage is unknown. Preserve build, date, source and licence; prices are scans, not live listings.',
      allow: Object.keys(toolDescriptions).filter(
        (tool) => !['search_knowledge', 'recent_changes'].includes(tool),
      ),
    },
    {
      namespace: `${name}-search`,
      description:
        'Complementary Everloot search with version fixed to Forever by the application. Cannot search Retail, Classic or archived wiki lore. Use TheWoWDB first for catalog facts.',
      allow: ['search_knowledge'],
      provided: { version: 'forever' },
    },
    {
      namespace: `${name}-changes`,
      description:
        'Official Forever changes only: blue posts, hotfixes and builds. The game filter is supplied by Wisp; Classic changes cannot be selected.',
      allow: ['recent_changes'],
      provided: { game: 'forever' },
    },
  ],
} satisfies BundledMcp;

export type LookupTool = 'item_categories' | 'entity_relations';
export type Lookup = (
  tool: LookupTool,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const isStructuredContent = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** The game catalog uses the same connection as the model tools. */
export const read = Effect.fn('Everloot.read')(function* (
  manager: Pick<McpManager, 'call'>,
  tool: LookupTool,
  args: Record<string, unknown>,
  allowed: () => boolean,
) {
  if (!allowed()) return yield* Effect.fail(Error('MCP tool disabled'));
  const result = yield* manager.call(
    name,
    tool,
    args,
    () => {
      if (!allowed()) throw Error('MCP tool disabled');
    },
    15_000,
  );
  if (result.isError || !isStructuredContent(result.structuredContent)) {
    return yield* Effect.fail(Error('Everloot could not answer ' + tool));
  }
  return result.structuredContent;
});
