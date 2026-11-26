import { defineEval } from '../harness.ts';
import { expects, presentedItemIds, recommendedByName, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';

// Crafted-only candidates in the fixture (Tailoring or Enchanting recipes),
// by ID for item references and by name for plain-text recommendations.
const CRAFTED = [7048, 4321, 4314, 4320, 7055, 5240];
const CRAFTED_NAMES =
  /Azure Silk Hood|Spider Silk Hood|Double-stitched Woolen Shoulders|Spidersilk Boots|Azure Silk Belt|Flame Wand/i;

export default defineEval({
  description:
    'From a real chat: Wisp recommended tailoring gear the player could neither make nor buy. Upgrades must come from drops, quests or vendors.',
  tags: ['gear'],
  question:
    "I don't have Tailoring and the auction house has none of the crafted gear. What upgrades can I actually get?",
  stubs: fedrathStubs(),
  gates: [
    replied(),
    expects(
      'presents no crafted-only item',
      (turn) => !presentedItemIds(turn).some((id) => CRAFTED.includes(id)),
    ),
    expects(
      'recommends no crafted-only item by name',
      (turn) => recommendedByName(turn.reply, CRAFTED_NAMES).length === 0,
    ),
    expects(
      'recommends gear from a quest, vendor or drop',
      (turn) =>
        /Seal of the Forsaken|Blessed Apprentice Boots|Woven Silk Shoulders|Fine Cloth Bracers|Spectral Light Pendant/i.test(
          turn.reply,
        ) || presentedItemIds(turn).some((id) => [15700, 3065, 14112, 3647, 12047].includes(id)),
    ),
  ],
});
