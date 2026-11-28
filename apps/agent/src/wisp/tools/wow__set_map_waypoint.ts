// @effect-migrated
import { Predicate } from 'effect';
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGameAction } from '../../tools/game-tool.ts';
import { waypointInput } from '../../contract/game-actions.ts';
export default enabledTool(
  'set_map_waypoint',
  defineTool({
    deferred: true,
    description:
      'Places one native WoW user waypoint, optionally with navigation, when the user asks to mark/show a destination. Coordinates are percentages 0–100 on a verified UI map ID. Resolve the destination and cite the supplied source; never invent coordinates or mix zone/map coordinate systems. Replaces the single native user pin and remembers the previous one for undo. Does not move the character.',
    inputSchema: effectToolInput(waypointInput, { layout: 'zod' }),
    label: {
      start: () => 'Marking map',
      complete: (_, output) =>
        Predicate.hasProperty(output, 'status') && output.status === 'completed'
          ? 'Marked map'
          : 'Tried to mark the map',
    },
    execute: (args, ctx) => runGameAction(ctx, { kind: 'set_waypoint', args }),
  }),
);
