import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { macroInput } from '@wisp/protocol/game-actions';
export default enabledTool(
  'create_macro',
  defineTool({
    deferred: true,
    description:
      'Creates a NEW character/account macro when the user asks to make/install one. Read known localized spell names before writing character-specific casts. Body max 255 UTF-8 bytes, name max 16. Standard spell/item/targeting commands only; no script/console/click/chat commands. Never overwrites, deletes, executes or puts a macro on a bar. Blocked in combat. Return the exact body and the returned macro reference so the user can review and click to pick it up.',
    inputSchema: macroInput,
    label: {
      start: () => 'Creating macro',
      complete: (_, output) =>
        (output as { status?: unknown } | undefined)?.status === 'completed'
          ? 'Created macro'
          : 'Tried to create a macro',
    },
    execute: async (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'create_macro', args } },
        ctx.abortSignal,
      ),
  }),
);
