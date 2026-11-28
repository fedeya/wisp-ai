import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { mapInput } from '../../contract/game-inspection.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';
export default enabledTool(
  'inspect_map',
  defineTool({
    deferred: true,
    description:
      'Reads current/parent maps, native user waypoint, specified UI map IDs, and optionally finds localized map names in the current world hierarchy. Use to verify map IDs/names before placing a destination. Map metadata does not provide NPC coordinates.',
    inputSchema: effectToolInput(mapInput, { layout: 'zod' }),
    label: { start: () => 'Reading maps', complete: () => 'Read maps' },
    execute: async (args, ctx) => runGame(ctx, (game) => game.readMap(ctx.session.id, args)),
  }),
);
