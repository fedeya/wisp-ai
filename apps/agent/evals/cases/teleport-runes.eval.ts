import { describeEval } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { mapStubs, runeStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'teleport-runes';

// From a real chat: Wisp guessed "the Valley of Spirits near the mage
// trainers" and had to correct itself. The vendor must come from item sources.
describeEval(
  name,
  {
    harness: wispHarness,
    judges: [keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it('names the rune vendor from the data', { tags: ['locations'] }, async ({ expect, run }) => {
      const result = await run({
        question: 'Where can I buy Runes of Teleportation?',
        stubs: [...runeStubs(), ...mapStubs(), ...fedrathStubs()],
      });
      const presented = presentedText(result);
      expect.soft(result.output.reply.trim()).not.toBe('');
      expect.soft(presented, 'names the vendor from the data').toMatch(/Horthus/i);
      expect.soft(presented, 'does not guess a district').not.toMatch(/Valley of Spirits/i);
    });
  },
);
