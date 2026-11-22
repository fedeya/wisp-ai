import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { dungeonsInput } from '@wisp/protocol/game-inspection';

export default enabledTool(
  'query_dungeons',
  defineTool({
    description:
      'Forever dungeons and raids from the game itself: every dungeon the group finder lists, with its suggested level range and group size in the client’s language, plus raids and dungeons it does not list; each with its entrance (UI map ID, zone name and 0–100 coordinates, ready for wow__set_map_waypoint) from Wisp’s table generated from the game’s map data. dungeon (part of a localized or English name, accents and case ignored) filters the list; wings are separate entries. groupFinder=false means the game could not list activities, so there are no level ranges. Forever adds dungeons and changes ranges, so prefer this over general knowledge. It does not cover quests or drops: use the quest and item source tools for those.',
    inputSchema: dungeonsInput,
    label: { start: () => 'Reading dungeons', complete: () => 'Read dungeons' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'dungeons', args } },
        ctx.abortSignal,
      ),
  }),
);
