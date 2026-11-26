import { describeEval } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import {
  keepsFormatting,
  recommendedByName,
  recommendedItemIds,
  turnView,
  visibleText,
} from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'obtainable-upgrades';

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

// From a real chat: Wisp recommended tailoring gear the player could neither
// make nor buy. Upgrades must come from drops, quests or vendors.
describeEval(
  name,
  {
    harness: wispHarness,
    judges: [keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it('recommends only gear the player can get', { tags: ['gear'] }, async ({ expect, run }) => {
      const result = await run({
        question:
          "I don't have Tailoring and the auction house has none of the crafted gear. What upgrades can I actually get?",
        stubs: fedrathStubs(),
      });
      const turn = turnView(result);
      const text = visibleText(turn);
      expect.soft(turn.reply.trim()).not.toBe('');
      expect
        .soft(
          recommendedItemIds(turn).filter((id) => CRAFTED.includes(id)),
          'presents no crafted-only item',
        )
        .toEqual([]);
      expect
        .soft(recommendedByName(text, CRAFTED_NAMES), 'recommends no crafted-only item by name')
        .toEqual([]);
      expect
        .soft(
          recommendedByName(text, OBTAINABLE_NAMES).length > 0 ||
            recommendedItemIds(turn).some((id) => OBTAINABLE.includes(id)),
          'recommends gear from a quest, vendor or drop',
        )
        .toBe(true);
    });
  },
);
