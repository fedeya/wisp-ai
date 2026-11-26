import { Effect, Schema } from 'effect';
import { everlootTools } from '@wisp/protocol/capabilities';
import type { BundledMcp, McpManager } from './mcp-manager.ts';

export const name = 'everloot';

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
  toolGroups: [
    {
      namespace: name,
      description:
        'Complementary Forever-only observations and reference pages: drops, vendors, quest relations, world locations, talents, professions and realm scan history. Use TheWoWDB for the primary catalog. Missing coverage is unknown. Preserve build, date, source and licence; prices are scans, not live listings.',
      allow: everlootTools.filter((tool) => !['search_knowledge', 'recent_changes'].includes(tool)),
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
