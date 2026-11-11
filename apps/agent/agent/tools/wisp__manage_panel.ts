import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { panelInput } from '@wisp/protocol/panels';
export default enabledTool(
  'manage_panel',
  defineTool({
    deferred: true,
    description:
      'List, read, save/update or remove persistent native panels for the current character. Save only when the user asks for a persistent tracker/panel. Reuse its ID when editing; first get the panel to preserve existing content. Uses the same generic UI components as replies. Optional stat/progress data bindings update locally without LLM calls: item_count (bags only, verified itemId), money (copper), level, quest_completed (verified questId). target is a goal/required quantity; bindings do not infer unknown IDs or recipes. Panels survive chats/reloads, can be moved/minimized/hidden and restored in Settings. No executable code.',
    inputSchema: panelInput,
    label: { start: () => 'Managing panels', complete: () => 'Managed panels' },
    execute: (input, ctx) =>
      agentRPC('panels', { eveSession: ctx.session.id, input }, ctx.abortSignal),
  }),
);
