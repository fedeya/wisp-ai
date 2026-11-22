import { defineEval } from 'eve/evals';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { questStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt = 'que misiones deberia hacer ahora?';

export default defineEval({
  description: 'Next-quest advice reads the quest log and recommends one suitable quest.',
  tags: ['tiers'],
  async test(t) {
    const session = await t.session({ stubs: [...questStubs(), ...fedrathStubs()] });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('next-quest', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__query_character');
    t.notCalledTool('web__web_search').soft();
  },
});
