import { defineTool } from 'eve/tools';
import { armorSearchInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'search_armor',
  defineTool({
    deferred: false,
    description:
      'Lists every armor, cloak, ring, necklace or trinket for one slot from the Forever game-file catalog (Everloot) that the character can equip by required level (or the given range), read live from the game with name, quality, item level, required level, stats and raw stat differences against the weakest matching equipped slot. Give the armor type of the character for body slots. Returns all matches ordered by item level gain; choosing among them is yours. Catalog entries are unconfirmed game-file data: confirm a source before recommending. Not stat weights or DPS; loadingIds were not cached yet.',
    inputSchema: armorSearchInput,
    label: { start: () => 'Searching armor', complete: () => 'Searched armor' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'search_armor', args } },
        ctx.abortSignal,
        60_000,
      ),
  }),
);
