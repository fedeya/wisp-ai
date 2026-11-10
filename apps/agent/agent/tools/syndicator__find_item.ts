import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { storedItemInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'find_item',
  defineTool({
    deferred: true,
    description:
      'Locate a verified item ID using Syndicator public API, including Baganator inventory data. Cached bag, bank, mail, equipped and auction counts across visible characters on the same connected realm and faction; guild storage requires includeGuild=true. Results are cached observations, not proof the item is currently accessible or absent. Use core character/resource reads for fresh bags; never claim to transfer items.',
    inputSchema: storedItemInput,
    label: { start: () => 'Finding stored item' },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'stored_item', args } },
        ctx.abortSignal,
      ),
  }),
);
