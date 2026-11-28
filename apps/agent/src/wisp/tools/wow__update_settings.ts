// @effect-migrated
import { Predicate } from 'effect';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGameAction } from '../../tools/game-tool.ts';
import { settingsUpdate } from '../../contract/settings.ts';
export default enabledTool(
  'update_settings',
  defineTool({
    deferred: true,
    description:
      'Preview a bounded settings proposal using exact IDs and typed values obtained from wow__get_settings. Returns before/after values and a transactionId; nothing is applied during preview. Apply an existing transaction only when requested by the user. The UI can offer an Apply button. Changes are checked for stale values, applied through APIs/setters and verified; failed changes attempt rollback. Never edits addon source code. No execute/reset/delete/profile operations.',
    inputSchema: effectToolInput(settingsUpdate, { layout: 'zod' }),
    label: {
      start: ({ operation }) =>
        operation === 'preview' ? 'Previewing settings changes' : 'Updating settings',
      complete: ({ operation }, output) => {
        const completed = Predicate.hasProperty(output, 'status') && output.status === 'completed';
        if (operation === 'preview') {
          return completed ? 'Previewed settings changes' : 'Tried to preview settings changes';
        }
        return completed ? 'Updated settings' : 'Tried to update settings';
      },
    },
    execute: (args, ctx) => runGameAction(ctx, { kind: 'update_settings', args }),
  }),
);
