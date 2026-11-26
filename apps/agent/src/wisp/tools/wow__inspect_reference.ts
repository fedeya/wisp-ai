import { defineTool } from '@wisp/agent/tool';
import { referenceInput } from '../../contract/game-inspection.ts';
import { inspectGame } from '../../tools/game-tool.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'inspect_reference',
  defineTool({
    description:
      'Reads an item, spell, talent (spell ID) or quest from the live game API, including available tooltip text and requirements. Use verified IDs only. For an item or spell, set includeCooldown=true to read its current cooldown. Spell timers exclude the global cooldown. Zero time means no active timer; ownership, learned status, charges and usability require separate evidence. Item reads already wait for the client cache; an item still loading is unknown, so do not retry it but use thewowdb__get_database_entity for catalog details and Everloot for observed sources and relations.',
    inputSchema: referenceInput,
    label: {
      start: ({ kind }) => 'Inspecting ' + kind,
      complete: ({ kind }) => 'Inspected ' + kind,
    },
    execute: async (args, ctx) => inspectGame(ctx, { kind: 'reference', args }),
  }),
);
