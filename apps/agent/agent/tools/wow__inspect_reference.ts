import { defineTool } from 'eve/tools';
import { referenceInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_reference',
  defineTool({
    description:
      'Reads an item, spell, talent (spell ID) or quest from the live game API, including available tooltip text and requirements. Use verified IDs only. Uncached data can be unavailable; retry after loading or use thewowdb__get_database_entity for catalog details and Everloot for observed sources and relations.',
    inputSchema: referenceInput,
    label: {
      start: ({ kind }) => 'Inspecting ' + kind,
      complete: ({ kind }) => 'Inspected ' + kind,
    },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'reference', args } },
        ctx.abortSignal,
      ),
  }),
);
