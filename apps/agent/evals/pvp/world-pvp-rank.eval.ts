import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { noLookupStubs, pvpStubs } from '../fixtures/world.ts';
import { commonChecks } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt = 'Does killing Alliance players in the open world get me out of Civilian?';

export default defineEval({
  description:
    'From real chats: Wisp said world kills raise the PvP rank in one chat and that they do not in another. In Forever they give Honor, not rank points.',
  tags: ['pvp'],
  async test(t) {
    const session = await t.session({
      stubs: [...pvpStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('world-pvp-rank', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    t.calledTool('wow__query_character');
    const reply = turn.reply ?? '';
    t.check(
      reply,
      satisfies(
        (text: string) =>
          /^\W*no\b/i.test(text) ||
          /(doesn['’]?t|does not|won['’]?t|will not|not)\b[^.]{0,80}\b(rank|Civilian)/i.test(text),
        'says world kills do not raise the rank',
      ),
    );
    t.check(
      reply,
      satisfies(
        (text: string) => /battleground/i.test(text) && /honor/i.test(text),
        'points to battlegrounds and Honor',
      ),
    );
  },
});
