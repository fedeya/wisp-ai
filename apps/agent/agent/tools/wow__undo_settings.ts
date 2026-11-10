import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { settingsUndo } from '@wisp/protocol/settings';
export default enabledTool(
  'undo_settings',
  defineTool({
    deferred: true,
    description:
      'Undo a previously applied settings transaction for the same character. Checks that the current values still equal Wisp’s changes; never overwrites subsequent player changes. No code editing.',
    inputSchema: settingsUndo,
    label: { start: () => 'Restoring settings' },
    execute: (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'undo_settings', args } },
        ctx.abortSignal,
      ),
  }),
);
