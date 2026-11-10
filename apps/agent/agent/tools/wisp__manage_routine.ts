import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { routineInput } from '@wisp/protocol/routines';
export default enabledTool(
  'manage_routine',
  defineTool({
    deferred: true,
    description:
      'Discover event capabilities (catalog), list/get, save/update, pause/resume or remove character routines. Only create or change a routine on the user’s request. Discover the catalog before choosing triggers and filters. Triggers are OR, filters within an event are AND. Intervals run only while this character is connected and outside combat; missed intervals coalesce. multiple_of matches absolute values (level % 2 = 0 means even levels). An event signals a change, not proof that a goal is met: put semantic checks and verified item/quest IDs in the instruction. Each run uses a fresh conversation and current readings. save replaces the definition; get before editing. No arbitrary code or unsupported event names. Background runs cannot mutate routines.',
    inputSchema: routineInput,
    label: { start: () => 'Managing routines' },
    execute: (input, ctx) =>
      agentRPC('routines', { eveSession: ctx.session.id, input }, ctx.abortSignal),
  }),
);
