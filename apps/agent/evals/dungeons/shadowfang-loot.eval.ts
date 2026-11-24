import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { commonChecks } from '../checks.ts';
import { saveTurn } from '../report.ts';

const prompt = 'what could Shadowfang Keep drop that would actually help me?';

export default defineEval({
  description:
    'A level 21 mage asks what Shadowfang Keep drops for him; the agent reads the loot tool instead of the web and recommends mage gear.',
  tags: ['dungeons', 'gear'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('shadowfang-loot', prompt, turn, performance.now() - started);
    turn.expectOk();
    commonChecks(t, turn);
    t.calledTool('wow__dungeon_loot');
    t.notCalledTool('web__web_search').soft();
    t.maxToolCalls(8).soft();
    const reply = turn.reply ?? '';
    const presented = JSON.stringify(
      turn.toolCalls.filter((call) => call.name === 'wisp__present_ui').map((call) => call.input),
    );
    t.check(
      reply + presented,
      satisfies(
        (text: string) =>
          /Robes of Arugal|Odo's Ley Staff|Blindwatcher Hood|Gravedirt Amulet|Belt of Arugal|"id":(6324|6318|273645|273457|6392)/i.test(
            text,
          ),
        'recommends mage upgrades from the loot reading',
      ),
    );
    t.check(
      reply,
      satisfies(
        (text: string) =>
          !/Phantom Armor|Haunting Blade|Wolfmaster Cape|Girdle of the Blindwatcher/i.test(text),
        'does not recommend gear a mage cannot use or that lacks caster stats',
      ),
    );
  },
});
