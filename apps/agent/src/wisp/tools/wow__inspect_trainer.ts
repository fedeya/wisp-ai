import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { NoArgs } from '../../contract/tool-inputs.ts';
import { runGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_trainer',
  defineTool({
    deferred: true,
    description:
      'Reads offers, learning status, costs and requirements from the trainer window currently open in WoW. Filters may hide offers. The user must talk to a trainer first. Does not train or spend money.',
    inputSchema: effectToolInput(NoArgs, { layout: 'zod' }),
    label: { start: () => 'Inspecting trainer', complete: () => 'Inspected trainer' },
    execute: async (args, ctx) => runGame(ctx, (game) => game.readTrainer(ctx.session.id, args)),
  }),
);
