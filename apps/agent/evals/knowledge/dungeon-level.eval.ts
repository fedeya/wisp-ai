import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt =
  'cuando voy a empezar a poder hacer mazmorras? cual es el nivel adecuado y en que niveles hay dungeons?';

export default defineEval({
  description: 'A dungeon-level question answers from the dungeon journal.',
  tags: ['tiers'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('dungeon-level', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.check(
      turn.reply ?? '',
      satisfies((text: string) => /Sima Ígnea|Ragefire|RFC/i.test(text), 'names the first dungeon'),
    );
  },
});
