import { defineTool } from 'eve/tools';
import { petInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_pet',
  defineTool({
    deferred: true,
    description:
      'Read the current owned pet identity/level, learned pet-bank spell IDs and separately observed pet action-bar autocast states. Each call is a fresh bounded read. Commands and non-spell buttons are not learned spells. Missing from the bar never means unlearned or disabled; incomplete/unknown/stale sections cannot establish absence. Read-only: never casts, toggles, feeds, trains, summons or commands a pet.',
    inputSchema: petInput,
    label: { start: () => 'Inspecting pet', complete: () => 'Inspected pet' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'pet', args } },
        ctx.abortSignal,
      ),
  }),
);
