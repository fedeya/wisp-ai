import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { NoArgs } from '../../contract/tool-inputs.ts';
import { runGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_target',
  defineTool({
    description:
      'Reads the currently selected target: name, NPC ID when available, level, classification, faction and hostility. Does not infer drops, quest involvement, target coordinates or fight difficulty from level alone.',
    inputSchema: effectToolInput(NoArgs, { layout: 'zod' }),
    label: { start: () => 'Inspecting target', complete: () => 'Inspected target' },
    execute: async (args, ctx) => runGame(ctx, (game) => game.readTarget(ctx.session.id, args)),
  }),
);
