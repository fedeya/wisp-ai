import { defineTool } from 'eve/tools';
import { compareInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'compare_items',
  defineTool({
    deferred: true,
    description:
      'Reads candidate items and currently equipped items with raw stat differences for matching equipment slots. Specify slot to compare a particular slot. No simulated DPS or stat weights. Two-handed/dual-wield and set effects require separate reasoning; unavailable stats are unknown.',
    inputSchema: compareInput,
    label: { start: () => 'Comparing equipment', complete: () => 'Compared equipment' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'compare_items', args } },
        ctx.abortSignal,
      ),
  }),
);
