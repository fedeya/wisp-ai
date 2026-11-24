import { defineEval } from '../harness.ts';
import { expects, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'A level 21 mage asks about one boss; the agent reads that boss in full and points out the sword he could train for.',
  tags: ['dungeons', 'gear'],
  question: 'what does Baron Silverlaine drop? anything for me?',
  stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    expects('filters the loot by the boss', (turn) =>
      turn.toolCalls.some(
        (call) =>
          call.name === 'wow__dungeon_loot' &&
          /silverlaine/i.test(String((call.input as { boss?: string }).boss)),
      ),
    ),
    // Wisp names items through registered references, so check those too.
    expects('names the caster drops', (turn) => /Spellblade|Family Seal/i.test(turn.presented)),
    expects(
      'does not name the mace a mage cannot use in its own words',
      (turn) => !/Baron's Scepter/i.test(turn.reply),
    ),
  ],
  scorers: [
    expects(
      'says the sword needs training before he can use it',
      (turn) => !/Spellblade/i.test(turn.reply) || /train|weapon master|learn/i.test(turn.reply),
    ),
  ],
});
