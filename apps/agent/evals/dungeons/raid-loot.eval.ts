import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt = 'what drops in Molten Core? I want to know the bosses and what each one drops';

export default defineEval({
  description:
    'A raid-wide loot question stays within the response cap: the tool answers a per-boss summary, not every item.',
  tags: ['dungeons'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('raid-loot', prompt, turn, performance.now() - started);
    turn.expectOk();
    t.calledTool('wow__dungeon_loot');
    t.notCalledTool('web__web_search').soft();
    const sizes = turn.toolCalls
      .filter((call) => call.name === 'wow__dungeon_loot')
      .map((call) => JSON.stringify(call.output ?? '').length);
    t.check(
      sizes,
      satisfies(
        (values: number[]) => values.every((size) => size < 45_000),
        'each loot result stays under the size cap',
      ),
    );
    t.check(
      turn.reply ?? '',
      satisfies(
        (text: string) => /Lucifron|Magmadar|Ragnaros/i.test(text),
        'names Molten Core bosses from the loot data',
      ),
    );
  },
});
