import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { waypointInput } from '@wisp/protocol/game-actions';
export default enabledTool(
  'set_map_waypoint',
  defineTool({
    deferred: true,
    description:
      'Places one native WoW user waypoint, optionally with navigation, when the user asks to mark/show a destination. Coordinates are percentages 0–100 on a verified UI map ID. Resolve the destination and cite the supplied source; never invent coordinates or mix zone/map coordinate systems. Replaces the single native user pin and remembers the previous one for undo. Does not move the character.',
    inputSchema: waypointInput,
    label: {
      start: () => 'Marking map',
      complete: (_, output) =>
        (output as { status?: unknown } | undefined)?.status === 'completed'
          ? 'Marked map'
          : 'Tried to mark the map',
    },
    execute: async (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'set_waypoint', args } },
        ctx.abortSignal,
      ),
  }),
);
