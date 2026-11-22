import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { dungeonsInput } from '@wisp/protocol/game-inspection';

export default enabledTool(
  'dungeons',
  defineTool({
    description:
      'Forever dungeon facts. Without dungeon: every dungeon the game’s group finder lists, with its suggested level range and group size in the client’s language, entrances (UI map ID and 0–100 coordinates, ready for wow__set_map_waypoint) from QuestieDB or Polestar, and, when Polestar is installed, best level, zone, enemy-territory note, whether it is new in Forever, quest count, and raids. With dungeon (a listed name or part of it): that entry plus, from Polestar, its quests for this faction (level, state for this character, objectives, start and finish points, rewards) and bosses in kill order with known drops. sources says which layers were available. Forever adds dungeons and changes ranges, so prefer this over general knowledge.',
    inputSchema: dungeonsInput,
    label: { start: () => 'Reading dungeons', complete: () => 'Read dungeons' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'dungeons', args } },
        ctx.abortSignal,
      ),
  }),
);
