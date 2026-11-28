import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';
import { questChainInput } from '../../contract/game-inspection.ts';
export default enabledTool(
  'get_quest_chain',
  defineTool({
    deferred: true,
    description:
      'Read a bounded graph of prerequisites and follow-ups for a verified quest ID from installed QuestieDB Forever. Group prerequisites require all; single prerequisites are alternatives. Direction, depth and limit bound traversal. Missing records, unknown completion and truncated branches are explicitly reported; never present a truncated graph as the complete chain. Use fresh character progression before recommending a quest.',
    inputSchema: effectToolInput(questChainInput, {
      parseOptions: rejectUnknownKeys,
      layout: 'zod',
    }),
    label: {
      start: ({ questId }) => `Reading the chain for quest #${questId}`,
      complete: ({ questId }) => `Looked up the chain for quest #${questId}`,
    },
    execute: (args, ctx) => runGame(ctx, (game) => game.readQuestieChain(ctx.session.id, args)),
  }),
);
