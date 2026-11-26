import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_hearthstone',
  defineTool({
    deferred: true,
    description:
      'Read the character’s current Hearthstone bind location by name. For the standard Hearthstone’s cooldown, use wow__inspect_reference with kind=item, id=6948, includeCooldown=true.',
    inputSchema: z.strictObject({}),
    label: { start: () => 'Reading Hearthstone bind', complete: () => 'Read Hearthstone bind' },
    execute: async (args, ctx) =>
      ctx.host('inspect', { inspection: { kind: 'hearthstone', args } }),
  }),
);
