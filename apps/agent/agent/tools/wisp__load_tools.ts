import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { toolGroupNames } from '@wisp/agent/model-tools';

export default defineTool({
  description:
    'Load tool groups for this turn: quests (details/chains/reputation), locations (maps/NPCs/waypoints), inventory (gear/bags/prices/resources), training, chat (recent WoW messages), knowledge (Forever catalog/web/MCP), memory (save/forget), settings, macros, simulation, panels, routines. Schemas only; read workflow instructions with eve__skill. Combine with relevant reads. Disabled tools stay disabled; loading performs no game action. Ordinary answers need no load call.',
  inputSchema: z.object({
    groups: z.array(z.enum(toolGroupNames)).min(1).max(toolGroupNames.length),
  }),
  label: { start: () => 'Loading capabilities' },
  execute: async ({ groups }) => ({ enabledGroups: [...new Set(groups)] }),
});
