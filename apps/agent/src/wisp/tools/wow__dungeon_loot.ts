import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { dungeonLootInput } from '../../contract/game-inspection.ts';
import { runGame } from '../../tools/game-tool.ts';
import { dungeonLoot } from '../dungeon-loot.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';
export default enabledTool(
  'dungeon_loot',
  defineTool({
    deferred: false,
    description:
      'Reads what each boss of a Forever dungeon or raid drops, from AtlasLoot Classic Forever (Wisp’s pinned copy): every boss with its loot, drop chance where known, and addedInForever for drops Forever added to classic bosses; Forever’s own instances are included. Without boss it answers a summary: every drop per boss with its name, drop chance and required level, and for upgrades itemLevelGain and statDelta against the weakest equipped item in its slot, which answers "what drops in X" and "what would help me" in one call. With boss, or detail full, every item also has its stats; do not read bosses one by one to recommend upgrades the summary already lists. Items come already read from the game: do not inspect them again before answering or presenting them. Equipment carries proficiency: usable, trainable (the class can learn that weapon or armor skill from trainableAtLevel; worth suggesting when the item is a big upgrade) or class_cannot_use; items the class can never use are only counted unless includeUnusable. Pass instanceMapId from wow__query_dungeons (or part of the English name) and optionally boss. Use it for "what drops in X" and gear goals in a dungeon instead of web searches; noDropsYet means AtlasLoot has not recorded drops for that boss.',
    inputSchema: effectToolInput(dungeonLootInput, {
      parseOptions: rejectUnknownKeys,
      layout: 'zod',
    }),
    label: { start: () => 'Reading dungeon loot', complete: () => 'Read dungeon loot' },
    execute: (args, ctx) =>
      dungeonLoot(args, (candidates) =>
        runGame(ctx, (game) => game.readGearCandidates(ctx.session.id, candidates), 60_000),
      ),
  }),
);
