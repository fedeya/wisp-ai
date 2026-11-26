import { defineTool } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { inspectGame } from '../../tools/game-tool.ts';
import { polestarGuideInput } from '../../contract/game-inspection.ts';
export default enabledTool(
  'get_guide_step',
  defineTool({
    deferred: true,
    description:
      'Read the Polestar leveling guide the player is following: guide title, the step shown in the guide window (title, note, goals with status and counts, quest/NPC/item IDs) and the next steps, plus overall progress. The guide is null when no guide is open. Goal status is Polestar’s own tracking; confirm quest state with the live quest log. Use questie tools with the returned IDs for locations and details. Read-only: never claim to change, skip or tick steps.',
    inputSchema: polestarGuideInput,
    label: { start: () => 'Reading Polestar guide', complete: () => 'Read Polestar guide' },
    execute: (args, ctx) => inspectGame(ctx, { kind: 'polestar_guide', args }),
  }),
);
