import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { commonChecks } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt =
  'when can I start doing dungeons? what level should I be and what levels are the dungeons for?';

export default defineEval({
  description:
    'A dungeon-level question answers from the dungeon list and does not read loot it was not asked for.',
  tags: ['tiers'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('dungeon-level', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    t.check(
      turn.reply ?? '',
      satisfies((text: string) => /Ragefire|RFC/i.test(text), 'names the first dungeon'),
    );
    // The other side of the loot evals: a level question needs no drops.
    t.notCalledTool('wow__dungeon_loot');
  },
});
