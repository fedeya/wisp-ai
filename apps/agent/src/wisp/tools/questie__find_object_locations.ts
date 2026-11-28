import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';
import { objectLocationsInput } from '../../contract/game-inspection.ts';
export default enabledTool(
  'find_object_locations',
  defineTool({
    deferred: true,
    description:
      'Find spawn coordinates for a verified quest object ID or exact localized name in installed QuestieDB Forever. Resolve the native UI map ID with wow__inspect_map. Returns validated map references; missing coverage and unverified coordinate frames are unknown, not proof of absence. These are database spawns, not live sightings or guaranteed active phases. Does not place a waypoint.',
    inputSchema: effectToolInput(objectLocationsInput, {
      parseOptions: rejectUnknownKeys,
      layout: 'zod',
    }),
    label: {
      start: () => 'Finding object locations',
      complete: () => 'Looked up object locations',
    },
    execute: (args, ctx) => runGame(ctx, (game) => game.findObjectLocations(ctx.session.id, args)),
  }),
);
