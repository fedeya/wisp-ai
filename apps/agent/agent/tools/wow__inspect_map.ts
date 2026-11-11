import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
export default enabledTool(
  'inspect_map',
  defineTool({
    deferred: true,
    description:
      'Reads current/parent maps, native user waypoint, specified UI map IDs, and optionally finds localized map names in the current world hierarchy. Use to verify map IDs/names before placing a destination. Map metadata does not provide NPC coordinates.',
    inputSchema: z.object({
      mapIds: z.array(z.number().int().positive()).max(20).default([]),
      query: z.string().min(1).max(80).optional(),
    }),
    label: { start: () => 'Reading maps', complete: () => 'Read maps' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'map', args } },
        ctx.abortSignal,
      ),
  }),
);
