import { defineEval } from '../harness.ts';
import { expects, recommendedItemIds, recommendedByName, replied, visibleText } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';

// Crafted-only candidates in the fixture (Tailoring or Enchanting recipes),
// by ID for item references and by name for plain-text recommendations.
const CRAFTED = [7048, 4321, 4314, 4320, 7055, 5240];
const CRAFTED_NAMES =
  /Azure Silk Hood|Spider Silk Hood|Double-stitched Woolen Shoulders|Spidersilk Boots|Azure Silk Belt|Flame Wand/i;

// Every mage upgrade in the fixture with a drop, quest or vendor source (the
// agility neck is left out), by ID and by name.
const OBTAINABLE = [3065, 3647, 5214, 5291, 11288, 12047, 14112, 15700];
const OBTAINABLE_NAMES =
  /Blessed Apprentice Boots|Fine Cloth Bracers|Shadow Wand|Sage's Staff|Carved Pearl Ring|Spectral Light Pendant|Woven Silk Shoulders|Seal of the Forsaken/i;

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
      (turn) => !recommendedItemIds(turn).some((id) => CRAFTED.includes(id)),
    ),
    expects(
      'recommends no crafted-only item by name',
      (turn) => recommendedByName(visibleText(turn), CRAFTED_NAMES).length === 0,
    ),
    expects(
      'recommends gear from a quest, vendor or drop',
      (turn) =>
        recommendedByName(visibleText(turn), OBTAINABLE_NAMES).length > 0 ||
        recommendedItemIds(turn).some((id) => OBTAINABLE.includes(id)),
    ),
  ],
});
