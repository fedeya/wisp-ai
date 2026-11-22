import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { saveTurn } from '../report.ts';

const prompt = 'find upgrades for me';

export default defineEval({
  description: 'A level 21 mage asks for upgrades; the agent searches real candidates per slot.',
  tags: ['gear', 'tiers'],
  async test(t) {
    const session = await t.session({ stubs: fedrathStubs() });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('find-upgrades', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__search_armor');
    t.notCalledTool('thewowdb__search_database').soft();
    t.maxToolCalls(30).soft();
    const reply = turn.reply ?? '';
    // Wisp names items through registered references, so check those too.
    const presented = JSON.stringify(
      turn.toolCalls.filter((call) => call.name === 'wisp__present_ui').map((call) => call.input),
    );
    t.check(
      reply + presented,
      satisfies(
        (text: string) => /"id":(4320|4314|7048)|Botas de seda de araña|Sobrehombros/i.test(text),
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
