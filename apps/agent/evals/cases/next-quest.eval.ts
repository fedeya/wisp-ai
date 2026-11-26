import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { questStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { avoidsTool } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'next-quest';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [avoidsTool('web__web_search'), keepsFormatting(), ...qualityJudges(name)],
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
