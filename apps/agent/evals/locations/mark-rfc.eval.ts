import { defineEval } from 'eve/evals';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs, mapStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt = 'me marcas la entrada de Sima Ígnea en el mapa?';

export default defineEval({
  description: 'A map request resolves the destination and places one waypoint.',
  tags: ['tiers'],
  async test(t) {
    const session = await t.session({
      stubs: [...mapStubs(), ...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('mark-rfc', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__set_map_waypoint', { count: 1 });
  },
});
