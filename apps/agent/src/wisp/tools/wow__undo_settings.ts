import { defineTool } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { settingsUndo } from '../../contract/settings.ts';
export default enabledTool(
  'undo_settings',
  defineTool({
    deferred: true,
    description:
      'Undo a previously applied settings transaction for the same character. Checks that the current values still equal Wisp’s changes; never overwrites subsequent player changes. No code editing.',
    inputSchema: settingsUndo,
    label: {
      start: () => 'Restoring settings',
      complete: (_, output) =>
        (output as { status?: unknown } | undefined)?.status === 'completed'
          ? 'Restored settings'
          : 'Tried to restore settings',
    },
    execute: (args, ctx) => ctx.host('action', { action: { kind: 'undo_settings', args } }),
  }),
);
