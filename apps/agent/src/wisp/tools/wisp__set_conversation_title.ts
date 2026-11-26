import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'set_conversation_title',
  defineTool({
    description: 'Renames the conversation at the user’s request.',
    inputSchema: z.object({
      title: z.string().min(1).max(60).describe('A short title in the user’s language.'),
    }),
    label: { start: () => 'Naming conversation' },
    execute: ({ title }, ctx) => ctx.host('title', { title }, 5000),
  }),
);
