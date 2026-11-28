// @effect-migrated
import { Predicate } from 'effect';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGameAction } from '../../tools/game-tool.ts';
import { settingsUndo } from '../../contract/settings.ts';
export default enabledTool(
  'undo_settings',
  defineTool({
    deferred: true,
    description:
      'Undo a previously applied settings transaction for the same character. Checks that the current values still equal Wisp’s changes; never overwrites subsequent player changes. No code editing.',
    inputSchema: effectToolInput(settingsUndo, { layout: 'zod' }),
    label: {
      start: () => 'Restoring settings',
      complete: (_, output) =>
        Predicate.hasProperty(output, 'status') && output.status === 'completed'
          ? 'Restored settings'
          : 'Tried to restore settings',
    },
    execute: (args, ctx) => runGameAction(ctx, { kind: 'undo_settings', args }),
  }),
);
