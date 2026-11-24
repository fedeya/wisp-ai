import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { mapStubs, runeStubs } from '../fixtures/world.ts';
import { commonChecks } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt = 'Where can I buy Runes of Teleportation?';

export default defineEval({
  description:
    'From a real chat: Wisp guessed "the Valley of Spirits near the mage trainers" and had to correct itself. The vendor must come from item sources.',
  tags: ['locations'],
  async test(t) {
    const session = await t.session({
      stubs: [...runeStubs(), ...mapStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('teleport-runes', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    const reply = turn.reply ?? '';
    t.check(
      reply,
      satisfies((text: string) => /Horthus/i.test(text), 'names the vendor from the data'),
    );
    t.check(
      reply,
      satisfies((text: string) => !/Valley of Spirits/i.test(text), 'does not guess a district'),
    );
  },
});
