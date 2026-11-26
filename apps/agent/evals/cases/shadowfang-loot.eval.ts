import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { avoidsTool, maxToolCalls, presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'shadowfang-loot';

describeEval(
  name,
  {
    harness: wispHarness,
    judges: [avoidsTool('web__web_search'), maxToolCalls(8), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it(
      'reads Shadowfang Keep loot and recommends mage gear',
      { tags: ['dungeons', 'gear'] },
      async ({ expect, run }) => {
        const result = await run({
          question: 'what could Shadowfang Keep drop that would actually help me?',
          stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
        });
        expect.soft(result.output.reply.trim()).not.toBe('');
        expect.soft(toolCalls(result).map((call) => call.name)).toContain('wow__dungeon_loot');
        expect
          .soft(presentedText(result), 'recommends mage upgrades from the loot reading')
          .toMatch(
            /Robes of Arugal|Odo's Ley Staff|Blindwatcher Hood|Gravedirt Amulet|Belt of Arugal|"id":(6324|6318|273645|273457|6392)/i,
          );
        expect
          .soft(result.output.reply, 'avoids gear a mage cannot use or that lacks caster stats')
          .not.toMatch(/Phantom Armor|Haunting Blade|Wolfmaster Cape|Girdle of the Blindwatcher/i);
      },
    );
  },
);
