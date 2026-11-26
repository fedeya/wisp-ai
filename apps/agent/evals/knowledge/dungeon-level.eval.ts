import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { wispHarness } from '../harness.ts';
import { qualityJudges } from '../quality-scorer.ts';

const name = 'dungeon-level';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: qualityJudges(name),
    judgeThreshold: null,
  },
  (it) => {
    it(
      'names the first dungeon without looking up loot',
      { tags: ['tiers'] },
      async ({ expect, run }) => {
        const result = await run({
          question:
            'when can I start doing dungeons? what level should I be and what levels are the dungeons for?',
          stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(result.output.reply).toMatch(/Ragefire|RFC/i);
        expect.soft(toolCalls(result).map((call) => call.name)).not.toContain('wow__dungeon_loot');
      },
    );
  },
);
