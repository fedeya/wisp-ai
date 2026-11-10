import { agentRPC } from '@wisp/agent/agent-rpc';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'set_conversation_title',
  defineTool({
    description:
      'Assigns a conversation title before replying to the first user message when conversation_context.needsTitle=true, including greetings or unclear topics, or renames it on an explicit user request. Summarize the message in the user’s language without inventing a topic.',
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(60)
        .describe(
          'A natural title in the user’s language based on the first message; prefer 3–6 words for a concrete topic, or a short greeting title when appropriate. No quotes, markup, invented topic or character-state dump.',
        ),
    }),
    label: { start: () => 'Naming conversation' },
    execute: ({ title }, ctx) =>
      agentRPC('title', { eveSession: ctx.session.id, title }, ctx.abortSignal, 5000),
  }),
);
