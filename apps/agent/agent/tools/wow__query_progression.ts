import { defineTool } from 'eve/tools';
import { progressionInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'query_progression',
  defineTool({
    deferred: true,
    description:
      'Reads active quests, completion flags for up to 40 verified quest IDs and reputations for specified faction IDs. Reuse IDs from the user or fresh quest log; resolve missing chain details with an available quest database only when needed. Not completed does not imply currently available or prerequisite-free.',
    inputSchema: progressionInput,
    label: { start: () => 'Reading progression' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'progression', args } },
        ctx.abortSignal,
      ),
  }),
);
