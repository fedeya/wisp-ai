import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { questStubs } from '../fixtures/world.ts';
import { wispHarness } from '../harness.ts';
import { avoidsTool } from '../judges.ts';
import { qualityJudges } from '../quality-scorer.ts';

const name = 'next-quest';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [avoidsTool('web__web_search'), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'reads the character before giving quest advice',
      { tags: ['tiers'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'what quests should I do now?',
          stubs: [...questStubs(), ...fedrathStubs()],
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result).map((call) => call.name)).toContain('wow__query_character');
      },
    );
  },
);
