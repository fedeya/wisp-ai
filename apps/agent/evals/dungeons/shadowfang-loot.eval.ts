import { defineEval } from '../harness.ts';
import { calledTool, expects, maxToolCalls, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';

export default defineEval({
  description:
    'A level 21 mage asks what Shadowfang Keep drops for him; the agent reads the loot tool instead of the web and recommends mage gear.',
  tags: ['dungeons', 'gear'],
  question: 'what could Shadowfang Keep drop that would actually help me?',
  stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [
    replied(),
    calledTool('wow__dungeon_loot'),
    expects('recommends mage upgrades from the loot reading', (turn) =>
      /Robes of Arugal|Odo's Ley Staff|Blindwatcher Hood|Gravedirt Amulet|Belt of Arugal|"id":(6324|6318|273645|273457|6392)/i.test(
        turn.presented,
      ),
    ),
    expects(
      'does not recommend gear a mage cannot use or that lacks caster stats',
      (turn) =>
        !/Phantom Armor|Haunting Blade|Wolfmaster Cape|Girdle of the Blindwatcher/i.test(
          turn.reply,
        ),
    ),
  ],
  scorers: [notCalledTool('web__web_search'), maxToolCalls(8)],
});
