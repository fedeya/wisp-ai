import { defineTool } from 'eve/tools';
import { auctionInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_auctions',
  defineTool({
    deferred: true,
    description:
      'Reads existing auction results already loaded while the auction house is open. Optional item ID filters that partial result set; it does not search or scan. All prices are copper. Does not bid, buy, post or cancel. For realm market values/history outside the AH use Everloot market_value/auction_history with freshness and coverage checks.',
    inputSchema: auctionInput,
    label: { start: () => 'Reading auction results' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'auctions', args } },
        ctx.abortSignal,
      ),
  }),
);
