import { createJudge, describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { avoidsTool, maxToolCalls, presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';
import type { WispInput } from '../runtime/harness.ts';

const name = 'find-upgrades';
const avoidsAgilityNeck = createJudge<WispInput, { reply: string }>(
  'does not push the agility neck to a mage',
  ({ output: { reply } }) => ({
    score: Number(!/Explorer's Medallion/i.test(reply) || /agility/i.test(reply)),
  }),
);

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [
      avoidsTool('thewowdb__search_database'),
      maxToolCalls(30),
      avoidsAgilityNeck,
      ...qualityJudges(name),
    ],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'searches gear candidates and recommends mage upgrades',
      { tags: ['gear', 'tiers'] },
      async ({ expect, run }) => {
        const result = await run({ question: 'find upgrades for me', stubs: fedrathStubs() });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result).map((call) => call.name)).toContain('wow__search_armor');
        expect
          .soft(presentedText(result), 'recommends searched candidates')
          .toMatch(/"id":(4320|4314|7048)|Spidersilk Boots|Shoulders|Azure Silk Hood/i);
      },
    );
  },
);
