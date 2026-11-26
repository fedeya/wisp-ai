import { createJudge, describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';
import type { WispInput } from '../runtime/harness.ts';

const name = 'boss-loot';
const swordTraining = createJudge<WispInput, { reply: string }>(
  'says the sword needs training before he can use it',
  ({ output: { reply } }) => ({
    score: Number(!/Spellblade/i.test(reply) || /train|weapon master|learn/i.test(reply)),
  }),
);

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [swordTraining, ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'reads one boss and recommends caster loot',
      { tags: ['dungeons', 'gear'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'what does Baron Silverlaine drop? anything for me?',
          stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result), 'filters the loot by the boss').toContainEqual(
          expect.objectContaining({
            name: 'wow__dungeon_loot',
            arguments: expect.objectContaining({ boss: expect.stringMatching(/silverlaine/i) }),
          }),
        );
        expect
          .soft(presentedText(result), 'names the caster drops')
          .toMatch(/Spellblade|Family Seal/i);
        expect
          .soft(result.output.reply, 'does not recommend the mace a mage cannot use')
          .not.toMatch(/Baron's Scepter/i);
      },
    );
  },
);
