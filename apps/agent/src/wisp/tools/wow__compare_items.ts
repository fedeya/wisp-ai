import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { compareInput } from '../../contract/game-inspection.ts';
import { runGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'compare_items',
  defineTool({
    deferred: true,
    description:
      'Reads candidate items and currently equipped items with raw stat differences for matching equipment slots. Specify slot to compare a particular slot. No simulated DPS or stat weights. Two-handed/dual-wield and set effects require separate reasoning; unavailable stats are unknown.',
    inputSchema: effectToolInput(compareInput, { layout: 'zod' }),
    label: { start: () => 'Comparing equipment', complete: () => 'Compared equipment' },
    execute: async (args, ctx) => runGame(ctx, (game) => game.compareItems(ctx.session.id, args)),
  }),
);
