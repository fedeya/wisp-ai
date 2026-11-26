import { defineEval } from '../harness.ts';
import { expects, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'A dungeon-level question answers from the dungeon list and does not read loot it was not asked for.',
  tags: ['tiers'],
  question:
    'when can I start doing dungeons? what level should I be and what levels are the dungeons for?',
  stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    expects('names the first dungeon', (turn) => /Ragefire|RFC/i.test(turn.reply)),
    // The other side of the loot evals: a level question needs no drops.
    notCalledTool('wow__dungeon_loot'),
  ],
});
