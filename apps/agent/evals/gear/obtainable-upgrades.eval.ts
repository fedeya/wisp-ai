import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { commonChecks, presentedItemIds } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt =
  "I don't have Tailoring and the auction house has none of the crafted gear. What upgrades can I actually get?";
// Crafted-only candidates in the fixture (Tailoring or Enchanting recipes),
// by ID for item references and by name for plain-text recommendations.
const CRAFTED = [7048, 4321, 4314, 4320, 7055, 5240];
const CRAFTED_NAMES =
  /Azure Silk Hood|Spider Silk Hood|Double-stitched Woolen Shoulders|Spidersilk Boots|Azure Silk Belt|Flame Wand/i;

export default defineEval({
  description:
    'From a real chat: Wisp recommended tailoring gear the player could neither make nor buy. Upgrades must come from drops, quests or vendors.',
  tags: ['gear'],
  async test(t) {
    const session = await t.session({ stubs: fedrathStubs() });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('obtainable-upgrades', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    t.check(
      presentedItemIds(turn),
      satisfies(
        (ids: number[]) => !ids.some((id) => CRAFTED.includes(id)),
        'presents no crafted-only item',
      ),
    );
    t.check(
      turn.reply ?? '',
      satisfies((text: string) => !CRAFTED_NAMES.test(text), 'names no crafted-only item'),
    );
    t.check(
      turn.reply ?? '',
      satisfies(
        (text: string) =>
          /Seal of the Forsaken|Blessed Apprentice Boots|Woven Silk Shoulders|Fine Cloth Bracers|Spectral Light Pendant/i.test(
            text,
          ) || presentedItemIds(turn).some((id) => [15700, 3065, 14112, 3647, 12047].includes(id)),
        'recommends gear from a quest, vendor or drop',
      ),
    );
  },
});
