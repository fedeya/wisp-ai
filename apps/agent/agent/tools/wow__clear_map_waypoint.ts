import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
export default enabledTool(
  'clear_map_waypoint',
  defineTool({
    deferred: true,
    description:
      'Removes the waypoint last placed by Wisp, restoring the prior pin if there was one. Refuses to alter a waypoint the player has changed since then. Use when asked to undo/remove Wisp’s marker.',
    inputSchema: z.object({}),
    label: { start: () => 'Removing map marker' },
    execute: async (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'clear_waypoint', args } },
        ctx.abortSignal,
      ),
  }),
);
