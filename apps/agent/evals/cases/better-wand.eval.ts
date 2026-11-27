import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { avoidsTool, maxToolCalls } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'better-wand';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [
      avoidsTool('thewowdb__search_database'),
      maxToolCalls(10),
      keepsFormatting(),
      ...qualityJudges(name),
    ],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'uses the weapon search for a wand question in Spanish',
      { tags: ['gear', 'tiers'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'hay alguna varita mejor que la mía que pueda conseguir?',
          stubs: fedrathStubs(),
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result)).toContainEqual(
          expect.objectContaining({
            name: 'wow__search_weapons',
            arguments: expect.objectContaining({ weaponType: 'wands' }),
          }),
        );
      },
    );
  },
);
