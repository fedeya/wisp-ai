// @effect-migrated
import { Predicate } from 'effect';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { NoArgs } from '../../contract/tool-inputs.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGameAction } from '../../tools/game-tool.ts';
export default enabledTool(
  'clear_map_waypoint',
  defineTool({
    deferred: true,
    description:
      'Removes the waypoint last placed by Wisp, restoring the prior pin if there was one. Refuses to alter a waypoint the player has changed since then. Use when asked to undo/remove Wisp’s marker.',
    inputSchema: effectToolInput(NoArgs, { layout: 'zod' }),
    label: {
      start: () => 'Removing map marker',
      complete: (_, output) =>
        Predicate.hasProperty(output, 'status') && output.status === 'completed'
          ? 'Removed map marker'
          : 'Tried to remove the map marker',
    },
    execute: (args, ctx) => runGameAction(ctx, { kind: 'clear_waypoint', args }),
  }),
);
