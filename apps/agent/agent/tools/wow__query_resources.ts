import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'query_resources',
  defineTool({
    deferred: true,
    description:
      'Reads current money in copper, bag items/free slots and skill/profession ranks. Used to check affordability, materials and profession plans. Collapsed skill headers may hide entries; missing API/data is not zero.',
    inputSchema: z.object({}),
    label: { start: () => 'Reading resources', complete: () => 'Read resources' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'resources', args } },
        ctx.abortSignal,
      ),
  }),
);
