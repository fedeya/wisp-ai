import { defineEval } from '../harness.ts';
import { calledTool, expects, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'A raid-wide loot question stays within the response cap: the tool answers a per-boss summary, not every item.',
  tags: ['dungeons'],
  question: 'what drops in Molten Core? I want to know the bosses and what each one drops',
  stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    calledTool('wow__dungeon_loot'),
    expects('each loot result stays under the size cap', (turn) =>
      turn.toolCalls
        .filter((call) => call.name === 'wow__dungeon_loot')
        .every((call) => JSON.stringify(call.output ?? '').length < 45_000),
    ),
    expects('names Molten Core bosses from the loot data', (turn) =>
      /Lucifron|Magmadar|Ragnaros/i.test(turn.reply),
    ),
  ],
  scorers: [notCalledTool('web__web_search')],
});
