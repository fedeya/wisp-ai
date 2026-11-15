import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';

export default enabledTool(
  'inspect_hearthstone',
  defineTool({
    deferred: true,
    description:
      'Read the standard Hearthstone (item 6948) in the character’s bags, its remaining cooldown in seconds, and the current bind location name. Each field can be unavailable independently. Use for personalized travel advice or questions about where the Hearthstone goes or when it is ready.',
    inputSchema: z.strictObject({}),
    label: { start: () => 'Checking Hearthstone', complete: () => 'Checked Hearthstone' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'hearthstone', args } },
        ctx.abortSignal,
      ),
  }),
);
