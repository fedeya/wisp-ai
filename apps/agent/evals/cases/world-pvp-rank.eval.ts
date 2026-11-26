import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { noLookupStubs, pvpStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'world-pvp-rank';

// From real chats: Wisp said world kills raise the PvP rank in one chat and
// that they do not in another. In Forever they give Honor, not rank points.
describeEval(
  name,
  {
    harness: wispHarness,
    judges: [keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it('says world kills give Honor but not rank', { tags: ['pvp'] }, async ({ expect, run }) => {
      const result = await run({
        question: 'Does killing Alliance players in the open world get me out of Civilian?',
        stubs: [...pvpStubs(), ...noLookupStubs(), ...fedrathStubs()],
      });
      const presented = presentedText(result);
      expect.soft(result.output.reply.trim()).not.toBe('');
      expect.soft(toolCalls(result).map((call) => call.name)).toContain('wow__query_character');
      // Whether the answer gets the rank rule right is left to the
      // unsupported-claim judge, whose facts state it: the wording varies.
      expect.soft(presented, 'points to battlegrounds').toMatch(/battleground/i);
      expect.soft(presented, 'points to Honor').toMatch(/honor/i);
    });
  },
);
