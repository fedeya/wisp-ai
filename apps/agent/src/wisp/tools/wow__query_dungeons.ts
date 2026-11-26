import { defineTool } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { dungeonsInput } from '../../contract/game-inspection.ts';

export default enabledTool(
  'query_dungeons',
  defineTool({
    description:
      'Forever dungeons and raids from the game itself: every dungeon the group finder lists, with its suggested level range and group size in the client’s language, plus raids and dungeons it does not list; each with its entrance (UI map ID, zone name and 0–100 coordinates, ready for wow__set_map_waypoint) from Wisp’s table generated from the game’s map data. dungeon (part of a localized or English name, accents and case ignored) filters the list; wings are separate entries. groupFinder=false means the game could not list activities, so there are no level ranges. Forever adds dungeons and changes ranges, so prefer this over general knowledge. It does not cover quests or drops: use the quest tools and wow__dungeon_loot (with instanceMapId) for those.',
    inputSchema: dungeonsInput,
    label: { start: () => 'Reading dungeons', complete: () => 'Read dungeons' },
    execute: async (args, ctx) => ctx.host('inspect', { inspection: { kind: 'dungeons', args } }),
  }),
);
