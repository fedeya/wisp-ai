import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { weaponSearchInput } from '../../contract/game-inspection.ts';
import { runGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'search_weapons',
  defineTool({
    deferred: false,
    description:
      'Lists every weapon of one type, shield or held-in-off-hand item from the Forever game-file catalog (Everloot) that the character can equip by required level (or the given range), read live from the game with name, quality, item level, required level, stats and raw stat differences against the weakest matching equipped slot. Weapon skill or proficiency is not checked. Returns all matches ordered by item level gain; choosing among them is yours. Catalog entries are unconfirmed game-file data: confirm a source before recommending. Not stat weights or DPS; loadingIds were not cached yet.',
    inputSchema: effectToolInput(weaponSearchInput, {
      parseOptions: rejectUnknownKeys,
      layout: 'zod',
    }),
    label: { start: () => 'Searching weapons', complete: () => 'Searched weapons' },
    execute: async (args, ctx) =>
      runGame(ctx, (game) => game.searchWeapons(ctx.session.id, args), 60_000),
  }),
);
