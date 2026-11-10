import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { settingsUpdate } from '@wisp/protocol/settings';
export default enabledTool(
  'update_settings',
  defineTool({
    deferred: true,
    description:
      'Preview a bounded settings proposal using exact IDs and typed values obtained from wow__get_settings. Returns before/after values and a transactionId; nothing is applied during preview. Apply an existing transaction only when requested by the user. The UI can offer an Apply button. Changes are checked for stale values, applied through APIs/setters and verified; failed changes attempt rollback. Never edits addon source code. No execute/reset/delete/profile operations.',
    inputSchema: settingsUpdate,
    label: { start: () => 'Updating settings' },
    execute: (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'update_settings', args } },
        ctx.abortSignal,
      ),
  }),
);
