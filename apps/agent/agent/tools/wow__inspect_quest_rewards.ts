import { defineTool } from 'eve/tools';
import { questRewardsInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_quest_rewards',
  defineTool({
    deferred: true,
    description:
      'Observe the currently player-opened quest turn-in reward dialog. Separate guaranteed rewards from mutually exclusive choices, retaining quantities and exact variant links and cached raw stats with matching equipped slots. Loading, restricted and unsupported options remain unknown. No navigation, selection, claim, polling or DPS simulation. Read again only on user request after dialog changes.',
    inputSchema: questRewardsInput,
    label: { start: () => 'Reading quest rewards', complete: () => 'Read quest rewards' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'quest_rewards', args } },
        ctx.abortSignal,
      ),
  }),
);
