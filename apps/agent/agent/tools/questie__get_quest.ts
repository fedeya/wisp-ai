import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { questInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'get_quest',
  defineTool({
    deferred: true,
    description:
      'Read a verified quest ID from installed QuestieDB Forever when details missing from the live quest log are needed: objectives, starters/finishers, level and race/class requirements, prerequisites and exclusions. For a simple next-quest recommendation, use the fresh quest log first. Sparse positional tuples are JSON objects with numeric-string keys; missing positions remain unknown. Static database data does not prove that the quest is currently offered or available to this character. Use wow__query_progression for fresh completion/progression. Resolve NPC and object objective IDs with the corresponding Questie location tools; never invent drop rates or coordinates.',
    inputSchema: questInput,
    label: {
      start: ({ questId }) => `Reading details for quest #${questId}`,
      complete: ({ questId }, output) => {
        const quest = output as { status?: unknown; reference?: { label?: unknown } } | undefined;
        if (quest?.status === 'unknown') {
          return `Looked up quest #${questId}`;
        }
        const label = quest?.reference?.label;
        const name = typeof label === 'string' ? label.trim() : '';
        return name ? `Read quest details for “${name}”` : `Read details for quest #${questId}`;
      },
    },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'questie_quest', args } },
        ctx.abortSignal,
      ),
  }),
);
