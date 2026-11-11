import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { itemPricesInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'get_item_prices',
  defineTool({
    deferred: true,
    description:
      'Read last-seen unit prices in copper for up to 20 verified item IDs through Auctionator public API on the current realm. Includes age in whole days when known; missing price or age is unknown, never zero. Cache reads work without the auction house open. Does not scan, search, buy or post auctions. For live already-loaded listings use wow__inspect_auctions; Everloot history is complementary, not this local cache.',
    inputSchema: itemPricesInput,
    label: {
      start: () => 'Reading cached auction prices',
      complete: () => 'Read cached auction prices',
    },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'item_prices', args } },
        ctx.abortSignal,
      ),
  }),
);
