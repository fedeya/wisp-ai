import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { NoArgs } from '../../contract/tool-inputs.ts';
import { runGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'query_resources',
  defineTool({
    deferred: true,
    description:
      'Reads current money in copper, bag items/free slots and skill/profession ranks. Used to check affordability, materials and profession plans. Collapsed skill headers may hide entries; missing API/data is not zero.',
    inputSchema: effectToolInput(NoArgs, { layout: 'zod' }),
    label: { start: () => 'Reading resources', complete: () => 'Read resources' },
    execute: async (args, ctx) => runGame(ctx, (game) => game.readResources(ctx.session.id, args)),
  }),
);
