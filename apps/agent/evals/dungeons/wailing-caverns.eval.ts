import { createJudge, describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { wispHarness } from '../harness.ts';
import type { WispInput } from '../harness.ts';
import { avoidsTool, maxToolCalls, presentedText } from '../judges.ts';
import { qualityJudges } from '../quality-scorer.ts';

const name = 'wailing-caverns';
const recommendsRun = createJudge<WispInput, { reply: string }>(
  'answers whether to go',
  ({ output: { reply } }) => ({
    score: Number(/\b(yes|worth|recommend|skip it|not worth)|I'?d (go|run|do|skip)/i.test(reply)),
  }),
);

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [avoidsTool('web__web_search'), maxToolCalls(6), recommendsRun, ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'resolves WC and recommends upgrades for empty slots',
      { tags: ['dungeons', 'gear'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'should I run WC? does anything in there drop that I could use?',
          stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        const presented = presentedText(result);
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result), 'reads Wailing Caverns loot by its map ID').toContainEqual(
          expect.objectContaining({
            name: 'wow__dungeon_loot',
            arguments: expect.objectContaining({ instanceMapId: 43 }),
          }),
        );
        expect
          .soft(presented, 'names drops that fill empty slots')
          .toMatch(
            /Slime-encrusted Pads|Snake Eye Kaleidoscope|Deep Fathom Ring|"id":(6461|273088|6463)/i,
          );
        expect
          .soft(presented, 'avoids gear a mage cannot use')
          .not.toMatch(/Armor of the Fang|Leggings of the Fang|Venomstrike|Stinging Viper/i);
      },
    );
  },
);
