import { defineTool } from 'eve/tools';
import { dungeonLootInput } from '@wisp/protocol/game-inspection';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'dungeon_loot',
  defineTool({
    deferred: false,
    description:
      'Reads what each boss of a Forever dungeon or raid drops, from AtlasLoot Classic Forever (Wisp’s pinned copy): every boss with its loot, drop chance where known, and addedInForever for drops Forever added to classic bosses; Forever’s own instances are included. Without boss it answers a summary: every drop per boss with its name, drop chance, required level and itemLevelGain when it beats current gear, which answers "what does X drop" in one call. With boss, or detail full, each item also has stats and statDelta against the weakest equipped item in its slot; ask for one boss at a time only when stats matter. Equipment carries proficiency: usable, trainable (the class can learn that weapon or armor skill from trainableAtLevel; worth suggesting when the item is a big upgrade) or class_cannot_use; items the class can never use are only counted unless includeUnusable. Pass instanceMapId from wow__query_dungeons (or part of the English name) and optionally boss. Use it for "what drops in X" and gear goals in a dungeon instead of web searches; noDropsYet means AtlasLoot has not recorded drops for that boss.',
    inputSchema: dungeonLootInput,
    label: { start: () => 'Reading dungeon loot', complete: () => 'Read dungeon loot' },
    execute: async (args, ctx) =>
      agentRPC(
        'inspect',
        { eveSession: ctx.session.id, inspection: { kind: 'dungeon_loot', args } },
        ctx.abortSignal,
        60_000,
      ),
  }),
);
