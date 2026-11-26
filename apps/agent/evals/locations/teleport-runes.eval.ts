import { defineEval } from '../harness.ts';
import { expects, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { mapStubs, runeStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'From a real chat: Wisp guessed "the Valley of Spirits near the mage trainers" and had to correct itself. The vendor must come from item sources.',
  tags: ['locations'],
  question: 'Where can I buy Runes of Teleportation?',
  stubs: [...runeStubs(), ...mapStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    expects('names the vendor from the data', (turn) => /Horthus/i.test(turn.presented)),
    expects('does not guess a district', (turn) => !/Valley of Spirits/i.test(turn.presented)),
  ],
});
