import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { npcLocationsInput } from '@wisp/protocol/game-inspection';
export default enabledTool(
  'find_npc_locations',
  defineTool({
    deferred: true,
    description:
      'Find NPC coordinates using installed QuestieDB Forever. For a transmog NPC use mode=services,service=Transmogrifier; for other services select Barber, Banker, Auctioneer, Innkeeper, Flight Master, Repair, Battlemaster, Arcane Reforger or Weapon Master. For a class trainer use mode=class_trainers,class=MAGE/etc. Service/class lookups discover NPC IDs and spawn pins directly; do not require an NPC name first. For another NPC provide an exact localized name or verified ID. Supply a native UI map ID from wow__inspect_map for a requested city; omitted mapId uses the current map. Only the Forever provider is accepted. Returned locations have native-map percentages and map references. Cite QuestieDB Forever; these are database spawn positions, not live sightings. Missing provider/data or ambiguous frames are unknown, not absence. No waypoint is placed; use wow__set_map_waypoint only when requested.',
    inputSchema: npcLocationsInput,
    label: { start: () => 'Finding NPC locations', complete: () => 'Looked up NPC locations' },
    execute: (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'npc_locations', args } },
        ctx.abortSignal,
      ),
  }),
);
