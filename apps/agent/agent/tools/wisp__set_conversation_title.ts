import { agentRPC } from '@wisp/agent/agent-rpc';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'set_conversation_title',
  defineTool({
    description: 'Sets the initial conversation title or renames it at the user’s request.',
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(60)
        .describe('A short title in the user’s language based on their message.'),
    }),
    label: { start: () => 'Naming conversation' },
    execute: ({ title }, ctx) =>
      agentRPC('title', { eveSession: ctx.session.id, title }, ctx.abortSignal, 5000),
  }),
);
