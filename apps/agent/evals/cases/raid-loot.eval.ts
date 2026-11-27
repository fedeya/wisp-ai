import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { avoidsTool } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'raid-loot';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [avoidsTool('web__web_search'), keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'summarizes raid loot by boss within the size cap',
      { tags: ['dungeons'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'what drops in Molten Core? I want to know the bosses and what each one drops',
          stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        const loot = toolCalls(result).filter((call) => call.name === 'wow__dungeon_loot');
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(loot).not.toHaveLength(0);
        for (const call of loot) {
          const output = call.status === 'ok' ? call.result : undefined;
          expect.soft(JSON.stringify(output ?? '').length).toBeLessThan(45_000);
        }
        expect.soft(result.output.reply).toMatch(/Lucifron|Magmadar|Ragnaros/i);
      },
    );
  },
);
