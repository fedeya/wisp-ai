import { defineTool } from 'eve/tools';
import { travelInput } from '@wisp/protocol/game-inspection';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
export default enabledTool(
  'inspect_travel',
  defineTool({
    description:
      'Read standard Hearthstone (6948) bag possession, cooldown, bind name, and flight destinations from the flight master window the player already opened. Only reachable nodes are selectable from this origin; this is not a global unlock list or travel graph. Closed/unsupported windows and unknown cooldowns are unavailable, not empty or ready. Read-only; never opens a window, uses an item or takes a flight.',
    inputSchema: travelInput,
    label: { start: () => 'Reading travel options' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'travel', args } },
        ctx.abortSignal,
      ),
  }),
);
