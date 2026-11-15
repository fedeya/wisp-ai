import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';

export default enabledTool(
  'inspect_hearthstone',
  defineTool({
    deferred: true,
    description:
      'Read the character’s current Hearthstone bind location by name. For the standard Hearthstone’s cooldown, use wow__inspect_reference with kind=item, id=6948, includeCooldown=true.',
    inputSchema: z.strictObject({}),
    label: { start: () => 'Reading Hearthstone bind', complete: () => 'Read Hearthstone bind' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'hearthstone', args } },
        ctx.abortSignal,
      ),
  }),
);
