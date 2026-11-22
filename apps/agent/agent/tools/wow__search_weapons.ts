import { defineTool } from 'eve/tools';
import { weaponSearchInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'search_weapons',
  defineTool({
    deferred: false,
    description:
      'Lists every weapon of one type, shield or held-in-off-hand item from the Forever game-file catalog (Everloot) that the character can equip by required level (or the given range), read live from the game with name, quality, item level, required level, stats and raw stat differences against the weakest matching equipped slot. Weapon skill or proficiency is not checked. Returns all matches ordered by item level gain; choosing among them is yours. Catalog entries are unconfirmed game-file data: confirm a source before recommending. Not stat weights or DPS; loadingIds were not cached yet.',
    inputSchema: weaponSearchInput,
    label: { start: () => 'Searching weapons', complete: () => 'Searched weapons' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'search_weapons', args } },
        ctx.abortSignal,
        60_000,
      ),
  }),
);
