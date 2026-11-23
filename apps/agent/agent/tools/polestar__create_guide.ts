import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { guideInput } from '@wisp/protocol/game-actions';
export default enabledTool(
  'create_guide',
  defineTool({
    deferred: true,
    description:
      'Build a step-by-step guide and open it in the player’s Polestar guide window, which tracks each goal from the game and leads its arrow there. Use when the player asks for a route, plan or checklist to follow (a quest chain, gathering a material, an errand run). Each step’s goals are open together and the step completes when they are done. Every quest, NPC, object and item ID and name must come from a verified read in this conversation (questie__get_quest, questie__find_npc_locations, questie__find_object_locations, the quest log, TheWoWDB); coordinates are 0–100 on a verified UI map ID, as for wow__set_map_waypoint. Never invent IDs or coordinates; leave a point out rather than guess. Prefer a short accurate guide; the whole guide must stay under 24 KB of JSON, so split long routes into several guides. To change a guide this tool made, call it again with the returned id and the full new steps: the player keeps their progress on steps that stay. Does not accept, complete or hand in anything itself.',
    inputSchema: guideInput,
    label: {
      start: () => 'Building Polestar guide',
      complete: (_, output) =>
        (output as { status?: unknown } | undefined)?.status === 'completed'
          ? 'Opened Polestar guide'
          : 'Tried to build a Polestar guide',
    },
    execute: async (args, ctx) =>
      agentRPC(
        'action',
        { eveSession: ctx.session.id, action: { kind: 'polestar_guide', args } },
        ctx.abortSignal,
      ),
  }),
);
