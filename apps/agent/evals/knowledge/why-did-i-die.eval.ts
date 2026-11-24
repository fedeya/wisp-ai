import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { combatStubs, noLookupStubs } from '../fixtures/world.ts';
import { commonChecks } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt = 'Why did I die?';

export default defineEval({
  description:
    'From a real chat: Wisp asked the player to paste the combat log. It must read the death recap from the game.',
  tags: ['combat'],
  async test(t) {
    const session = await t.session({
      stubs: [...combatStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('why-did-i-die', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    t.calledTool('wow__read_combat');
    const reply = turn.reply ?? '';
    t.check(
      reply,
      satisfies(
        (text: string) => /Deforester/i.test(text) && /Fireball/i.test(text),
        'names the killer and the killing blow',
      ),
    );
    t.check(
      reply,
      satisfies(
        (text: string) => !/paste|copy the|open (the )?combat log/i.test(text),
        'does not ask the player for the log',
      ),
    );
  },
});
