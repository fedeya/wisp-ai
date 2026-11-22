import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { dungeonsInput } from '@wisp/protocol/game-inspection';

export default enabledTool(
  'dungeons',
  defineTool({
    description:
      'Forever dungeon and raid journal from the Polestar addon. Without dungeon: every dungeon and raid with its level range, best level, group size, zone, entrance (UI map ID and 0–100 coordinates, ready for wow__set_map_waypoint), whether the entrance is in enemy territory, whether it is new in Forever, and its quest count for this faction. With dungeon (a name in any language or a key from the list): that dungeon’s summary plus its quests for this faction (level, state for this character, objectives, start and finish points, rewards) and its bosses in kill order with their known drops (item IDs, names, quality). Forever adds dungeons and changes ranges, so prefer this over general knowledge. Unavailable when Polestar is not installed; then use other sources.',
    inputSchema: dungeonsInput,
    label: { start: () => 'Reading dungeon journal', complete: () => 'Read dungeon journal' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'dungeons', args } },
        ctx.abortSignal,
      ),
  }),
);
