import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { objectLocationsInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'find_object_locations',
  defineTool({
    deferred: true,
    description:
      'Find spawn coordinates for a verified quest object ID or exact localized name in installed QuestieDB Forever. Resolve the native UI map ID with wow__inspect_map. Returns validated map references; missing coverage and unverified coordinate frames are unknown, not proof of absence. These are database spawns, not live sightings or guaranteed active phases. Does not place a waypoint.',
    inputSchema: objectLocationsInput,
    label: { start: () => 'Finding object locations' },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'object_locations', args } },
        ctx.abortSignal,
      ),
  }),
);
