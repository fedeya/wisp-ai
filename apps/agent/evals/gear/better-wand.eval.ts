import { defineEval } from 'eve/evals';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { saveTurn } from '../report.ts';

const prompt = 'hay alguna varita mejor que la mía que pueda conseguir?';

export default defineEval({
  description:
    'A wand question in Spanish on an English client uses the weapon search instead of guessing names; it keeps one non-English case in the suite.',
  tags: ['gear', 'tiers'],
  async test(t) {
    const session = await t.session({ stubs: fedrathStubs() });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('better-wand', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__search_weapons', { input: { weaponType: 'wands' } });
    t.notCalledTool('thewowdb__search_database').soft();
    t.maxToolCalls(10).soft();
  },
});
