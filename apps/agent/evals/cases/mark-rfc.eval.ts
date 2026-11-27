import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs, mapStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'mark-rfc';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [keepsFormatting(), keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'places one waypoint for the Ragefire Chasm entrance',
      { tags: ['tiers'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'can you mark the Ragefire Chasm entrance on my map?',
          stubs: [...mapStubs(), ...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect
          .soft(toolCalls(result).filter((call) => call.name === 'wow__set_map_waypoint'))
          .toHaveLength(1);
      },
    );
  },
);
