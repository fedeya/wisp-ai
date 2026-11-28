// @effect-migrated
import { Predicate } from 'effect';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGameAction } from '../../tools/game-tool.ts';
import { macroInput } from '../../contract/game-actions.ts';
export default enabledTool(
  'create_macro',
  defineTool({
    deferred: true,
    description:
      'Creates a NEW character/account macro when the user asks to make/install one. Read known localized spell names before writing character-specific casts. Body max 255 UTF-8 bytes, name max 16. Any macro command is allowed, including /run, /script, /click, /console and chat commands; tell the user plainly what such lines do. Never overwrites, deletes, executes or puts a macro on a bar. Blocked in combat. Return the exact body and the returned macro reference so the user can review and click to pick it up.',
    inputSchema: effectToolInput(macroInput, { layout: 'zod' }),
    label: {
      start: () => 'Creating macro',
      complete: (_, output) =>
        Predicate.hasProperty(output, 'status') && output.status === 'completed'
          ? 'Created macro'
          : 'Tried to create a macro',
    },
    execute: (args, ctx) => runGameAction(ctx, { kind: 'create_macro', args }),
  }),
);
