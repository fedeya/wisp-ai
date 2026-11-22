import { defineTool } from 'eve/tools';
import { itemSourcesInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'item_sources',
  defineTool({
    deferred: false,
    description:
      'Reads where up to 20 items come from in one call: NPCs that drop or sell them (with zones), quests that reward them and recipes that craft them, from Everloot player observations and game files named by QuestieDB and the game, plus the last-seen Auctionator unit price. Use it for the items you are considering instead of separate Everloot, TheWoWDB or price lookups. sourceKnown=false means no known source, not proof the item is unobtainable; prices are cached, not live listings.',
    inputSchema: itemSourcesInput,
    label: { start: () => 'Finding item sources', complete: () => 'Found item sources' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'item_sources', args } },
        ctx.abortSignal,
        60_000,
      ),
  }),
);
