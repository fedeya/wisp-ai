// @effect-migrated
import { Schema } from 'effect';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { Described } from '../../contract/tool-inputs.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'set_conversation_title',
  defineTool({
    description: 'Renames the conversation at the user’s request.',
    inputSchema: effectToolInput(
      Schema.Struct({
        title: Described(Schema.String, 'A short title in the user’s language.').check(
          Schema.isMinLength(1),
          Schema.isMaxLength(60),
        ),
      }),
      { layout: 'zod' },
    ),
    label: { start: () => 'Naming conversation' },
    execute: ({ title }, ctx) =>
      agentRPC('title', { agentSession: ctx.session.id, title }, ctx.abortSignal, 5000),
  }),
);
