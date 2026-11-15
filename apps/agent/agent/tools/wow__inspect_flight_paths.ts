import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { flightPathsInput } from '@wisp/protocol/game-inspection';

export default enabledTool(
  'inspect_flight_paths',
  defineTool({
    deferred: true,
    description:
      'Check whether this character can take a flight path (taxi) to a destination. Optional localized origin/destination filters search flight master maps and world map points. In maps, reachability and copper fare apply to the listed origin at observedAt; mapOpen means that map is still open. In worldMap, points give the game’s discovery status when reliable; learned points alone do not establish a route or fare. Unknown discovery or missing matches do not prove a point is locked. Ask the player to open the relevant flight master map to verify an unseen or stale route.',
    inputSchema: flightPathsInput,
    label: { start: () => 'Checking flight paths', complete: () => 'Checked flight paths' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'flight_paths', args } },
        ctx.abortSignal,
      ),
  }),
);
