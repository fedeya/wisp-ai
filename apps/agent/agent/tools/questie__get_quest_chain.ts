import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { questChainInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'get_quest_chain',
  defineTool({
    deferred: true,
    description:
      'Read a bounded graph of prerequisites and follow-ups for a verified quest ID from installed QuestieDB Forever. Group prerequisites require all; single prerequisites are alternatives. Direction, depth and limit bound traversal. Missing records, unknown completion and truncated branches are explicitly reported; never present a truncated graph as the complete chain. Use fresh character progression before recommending a quest.',
    inputSchema: questChainInput,
    label: {
      start: ({ questId }) => `Reading the chain for quest #${questId}`,
      complete: ({ questId }) => `Looked up the chain for quest #${questId}`,
    },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'questie_chain', args } },
        ctx.abortSignal,
      ),
  }),
);
