import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt = 'what does Baron Silverlaine drop? anything for me?';

export default defineEval({
  description:
    'A level 21 mage asks about one boss; the agent reads that boss in full and points out the sword he could train for.',
  tags: ['dungeons', 'gear'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('boss-loot', prompt, turn, performance.now() - started);
    turn.expectOk();
    const loot = turn.toolCalls.filter((call) => call.name === 'wow__dungeon_loot');
    t.check(
      loot.map((call) => call.input),
      satisfies(
        (inputs: unknown[]) =>
          inputs.some((input) => /silverlaine/i.test(String((input as { boss?: string }).boss))),
        'filters the loot by the boss',
      ),
    );
    const reply = turn.reply ?? '';
    // Wisp names items through registered references, so check those too.
    const presented = JSON.stringify(
      turn.toolCalls.filter((call) => call.name === 'wisp__present_ui').map((call) => call.input),
    );
    t.check(
      reply + presented,
      satisfies((text: string) => /Spellblade|Family Seal/i.test(text), 'names the caster drops'),
    );
    t.check(
      reply,
      satisfies(
        (text: string) => !/Spellblade/i.test(text) || /train|weapon master|learn/i.test(text),
        'says the sword needs training before he can use it',
      ),
    ).soft();
    t.check(
      reply,
      satisfies(
        (text: string) => !/Baron's Scepter/i.test(text),
        'does not name the mace a mage cannot use in its own words',
      ),
    );
  },
});
