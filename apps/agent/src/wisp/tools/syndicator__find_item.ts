import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';
import { storedItemInput } from '../../contract/game-inspection.ts';
export default enabledTool(
  'find_item',
  defineTool({
    deferred: true,
    description:
      'Locate a verified item ID using Syndicator public API, including Baganator inventory data. Cached bag, bank, mail, equipped and auction counts across visible characters on the same connected realm and faction; guild storage requires includeGuild=true. Results are cached observations, not proof the item is currently accessible or absent. Use core character/resource reads for fresh bags; never claim to transfer items.',
    inputSchema: effectToolInput(storedItemInput, {
      parseOptions: rejectUnknownKeys,
      layout: 'zod',
    }),
    label: { start: () => 'Finding stored item', complete: () => 'Checked stored items' },
    execute: (args, ctx) => runGame(ctx, (game) => game.findStoredItem(ctx.session.id, args)),
  }),
);
