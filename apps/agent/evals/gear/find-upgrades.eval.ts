import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { saveTurn } from '../report.ts';

const prompt = 'find upgrades for me';

export default defineEval({
  description: 'A level 21 mage asks for upgrades; the agent searches real candidates per slot.',
  tags: ['gear'],
  async test(t) {
    const session = await t.session({ stubs: fedrathStubs() });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('find-upgrades', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__search_armor');
    t.notCalledTool('thewowdb__search_database').soft();
    t.maxToolCalls(20).soft();
    const reply = turn.reply ?? '';
    t.check(
      reply,
      satisfies(
        (text: string) => /Botas de seda de araña|Sobrehombros|Capucha de seda azur/i.test(text),
        'recommends searched candidates',
      ),
    );
    t.check(
      reply,
      satisfies(
        (text: string) => !/Medallón de explorador/i.test(text) || /agilidad|agility/i.test(text),
        'does not push the agility neck to a mage',
      ),
    ).soft();
  },
});
