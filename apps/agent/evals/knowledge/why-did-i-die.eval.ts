import { defineEval } from '../harness.ts';
import { calledTool, expects, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { combatStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'From a real chat: Wisp asked the player to paste the combat log. It must read the death recap from the game.',
  tags: ['combat'],
  question: 'Why did I die?',
  stubs: [...combatStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    calledTool('wow__read_combat'),
    expects(
      'names the killer and the killing blow',
      (turn) => /Deforester/i.test(turn.reply) && /Fireball/i.test(turn.reply),
    ),
    expects(
      'does not ask the player for the log',
      (turn) => !/paste|copy the|open (the )?combat log/i.test(turn.reply),
    ),
  ],
});
