import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';

export default enabledTool(
  'inspect_hearthstone',
  defineTool({
    deferred: true,
    description:
      'Read the character’s current Hearthstone bind location by name. For the standard Hearthstone’s cooldown, use wow__inspect_reference with kind=item, id=6948, includeCooldown=true.',
    inputSchema: z.strictObject({}),
    label: { start: () => 'Reading Hearthstone bind', complete: () => 'Read Hearthstone bind' },
    execute: async (args, ctx) =>
      runGame(ctx, (game) => game.readHearthstone(ctx.session.id, args)),
  }),
);
