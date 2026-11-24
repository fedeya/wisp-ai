import { defineEval } from '../harness.ts';
import { expects, maxToolCalls, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'A level 21 mage asks whether Wailing Caverns is worth it; the agent resolves the abbreviation, reads its loot and weighs the level fit and the upgrades.',
  tags: ['dungeons', 'gear'],
  question: 'should I run WC? does anything in there drop that I could use?',
  stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    expects('reads Wailing Caverns loot by its map ID', (turn) =>
      turn.toolCalls.some(
        (call) =>
          call.name === 'wow__dungeon_loot' &&
          (call.input as { instanceMapId?: number }).instanceMapId === 43,
      ),
    ),
    expects('names drops that fill his empty slots', (turn) =>
      /Slime-encrusted Pads|Snake Eye Kaleidoscope|Deep Fathom Ring|"id":(6461|273088|6463)/i.test(
        turn.presented,
      ),
    ),
    expects(
      'does not recommend gear a mage cannot use',
      (turn) =>
        !/Armor of the Fang|Leggings of the Fang|Venomstrike|Stinging Viper/i.test(turn.presented),
    ),
  ],
  scorers: [
    notCalledTool('web__web_search'),
    maxToolCalls(6),
    expects('answers whether to go', (turn) =>
      /\b(yes|worth|recommend|skip it|not worth)|I'?d (go|run|do|skip)/i.test(turn.reply),
    ),
  ],
});
