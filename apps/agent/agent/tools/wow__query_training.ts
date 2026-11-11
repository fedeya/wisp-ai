import { defineTool } from 'eve/tools';
import { trainingInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'query_training',
  defineTool({
    deferred: true,
    description:
      "Consult the bundled Forever class ability catalog derived from What's Training, anywhere, without opening a trainer or installing another addon. Defaults to current class and filters its race/faction; another class retains restrictions. Search localized spell names, verified spell IDs or level ranges. Returns trainer levels, base prices, prior-rank and talent requirements, quest acquisition variants and current-class learned flags. Follow nextOffset for more results. If unresolvedNames > 0, retry after spell data loads or resolve the spell ID through a reference search. Missing matches are not proof of absence. Prices are undiscounted and static, not live offers. Cite sourceUrl and revision. Does not train or spend money.",
    inputSchema: trainingInput,
    label: {
      start: () => 'Looking up ability training',
      complete: () => 'Looked up ability training',
    },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'training', args } },
        ctx.abortSignal,
      ),
  }),
);
