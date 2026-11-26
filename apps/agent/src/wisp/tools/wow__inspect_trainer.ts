import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';
import { inspectGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_trainer',
  defineTool({
    deferred: true,
    description:
      'Reads offers, learning status, costs and requirements from the trainer window currently open in WoW. Filters may hide offers. The user must talk to a trainer first. Does not train or spend money.',
    inputSchema: z.object({}),
    label: { start: () => 'Inspecting trainer', complete: () => 'Inspected trainer' },
    execute: async (args, ctx) => inspectGame(ctx, { kind: 'trainer', args }),
  }),
);
