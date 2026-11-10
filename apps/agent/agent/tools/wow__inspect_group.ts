import { defineTool } from 'eve/tools';
import { groupInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_group',
  defineTool({
    description:
      'Fresh read-only party inspection: self and up to four members, identity, class, level, connected/dead state and visible helpful aura spell IDs. Optional spellIds filters exact IDs only. Only complete readable enumeration establishes absence; offline, hidden, restricted, changed or truncated observations remain unknown. Raids unsupported. Use query_character spells and inspect_reference to verify learned buffs and effects, never infer equivalences or roles. Compose an existing generic UI card when useful.',
    inputSchema: groupInput,
    label: { start: () => 'Inspecting party' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'group', args } },
        ctx.abortSignal,
      ),
  }),
);
