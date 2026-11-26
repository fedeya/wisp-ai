import { defineEval } from '../harness.ts';
import { calledTool, expects, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { noLookupStubs, pvpStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'From real chats: Wisp said world kills raise the PvP rank in one chat and that they do not in another. In Forever they give Honor, not rank points.',
  tags: ['pvp'],
  question: 'Does killing Alliance players in the open world get me out of Civilian?',
  stubs: [...pvpStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    calledTool('wow__query_character'),
    expects(
      'says world kills do not raise the rank',
      (turn) =>
        /^\W*no\b/i.test(turn.presented) ||
        /(doesn['’]?t|does not|won['’]?t|will not|not)\b[^.]{0,80}\b(rank|Civilian)/i.test(
          turn.presented,
        ),
    ),
    expects(
      'points to battlegrounds and Honor',
      (turn) => /battleground/i.test(turn.presented) && /honor/i.test(turn.presented),
    ),
  ],
});
