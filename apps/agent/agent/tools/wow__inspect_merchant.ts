import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_merchant',
  defineTool({
    deferred: true,
    description:
      'Read current open merchant identity and bounded filtered offers: item links/IDs, copper cost per purchase bundle, stock, exposed usability and capture time. Extended/unknown costs are unsupported, never free. Re-read after merchant changes; no purchases or UI navigation. Compose with fresh query_resources for budget advice.',
    inputSchema: z.strictObject({
      offset: z.number().int().min(0).max(500).default(0),
      limit: z.number().int().min(1).max(40).default(20),
    }),
    label: { start: () => 'Inspecting merchant', complete: () => 'Inspected merchant' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        {
          eveSession: ctx.session.id,
          inspection: { kind: 'merchant', args },
        },
        ctx.abortSignal,
      ),
  }),
);
