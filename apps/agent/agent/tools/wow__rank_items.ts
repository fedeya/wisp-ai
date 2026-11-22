import { defineTool } from 'eve/tools';
import { rankItemsInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'rank_items',
  defineTool({
    deferred: true,
    description:
      'Reads up to 100 candidate item IDs from the live game in one call, such as an Everloot item_categories listing for one slot, armor type and quality. Keeps equipment whose required level fits the character (or the given range) and returns the best few with name, item level, required level, stats and raw stat differences against the weakest matching equipped slot, sorted by item level gain. Not stat weights or DPS; armor/weapon proficiency is not checked. loadingIds were not cached yet.',
    inputSchema: rankItemsInput,
    label: { start: () => 'Ranking gear candidates', complete: () => 'Ranked gear candidates' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'rank_items', args } },
        ctx.abortSignal,
      ),
  }),
);
