import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';
import { inspectGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_target',
  defineTool({
    description:
      'Reads the currently selected target: name, NPC ID when available, level, classification, faction and hostility. Does not infer drops, quest involvement, target coordinates or fight difficulty from level alone.',
    inputSchema: z.object({}),
    label: { start: () => 'Inspecting target', complete: () => 'Inspected target' },
    execute: async (args, ctx) => inspectGame(ctx, { kind: 'target', args }),
  }),
);
