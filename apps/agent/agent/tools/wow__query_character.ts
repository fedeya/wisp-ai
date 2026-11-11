import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { characterSections } from '@wisp/protocol/agent-rpc';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'query_character',
  defineTool({
    description:
      'Read only the character sections needed for the question. quests includes rewardXP when the game provides the experience reward for the character; missing rewardXP is unknown, not zero. quests normally reads the local synchronized quest cache, revalidated when this turn was submitted, without contacting the game. Other sections are read live. Set refresh=true for an explicit update after submission; missing/incomplete cache falls back to live reading. Never use conversation memory as live state. talents includes unspentPoints, spentPoints, totalPoints, selected ranks/branches and pending changes. Request related sections together. Unknown data does not mean absence or zero.',
    inputSchema: z.object({
      sections: characterSections,
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass the turn-verified quest cache only when an updated reading is needed.'),
    }),
    label: {
      start: ({ sections }) => 'Reading ' + sections.join(', '),
      complete: ({ sections }) => 'Read ' + sections.join(', '),
    },
    execute: ({ sections, refresh }, ctx) =>
      agentRPC('state', { eveSession: ctx.session.id, sections, refresh }, ctx.abortSignal),
  }),
);
