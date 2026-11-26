import { describeEval, toolCalls } from 'vitest-evals';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { combatStubs, noLookupStubs } from '../fixtures/world.ts';
import { keepsFormatting } from '../judges/checks.ts';
import { qualityJudges } from '../judges/quality-scorer.ts';
import { presentedText } from '../judges/tool-calls.ts';
import { wispHarness } from '../runtime/harness.ts';

const name = 'why-did-i-die';

// From a real chat: Wisp asked the player to paste the combat log. It must
// read the death recap from the game.
describeEval(
  name,
  {
    harness: wispHarness,
    judges: [keepsFormatting(), ...qualityJudges(name)],
    judgeThreshold: null,
  },
  (it) => {
    it('reads the death recap from the game', { tags: ['combat'] }, async ({ expect, run }) => {
      const result = await run({
        question: 'Why did I die?',
        stubs: [...combatStubs(), ...noLookupStubs(), ...fedrathStubs()],
      });
      const presented = presentedText(result);
      expect.soft(result.output.reply.trim()).not.toBe('');
      expect.soft(toolCalls(result).map((call) => call.name)).toContain('wow__read_combat');
      expect.soft(presented, 'names the killer').toMatch(/Deforester/i);
      expect.soft(presented, 'names the killing blow').toMatch(/Fireball/i);
      expect
        .soft(presented, 'does not ask the player for the log')
        .not.toMatch(/paste|copy the|open (the )?combat log/i);
    });
  },
);
