import { defineEval } from 'eve/evals';
import { satisfies } from 'eve/evals/expect';
import { fedrathStubs, playerMessage } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs } from '../fixtures/world.ts';
import { saveTurn } from '../report.ts';

const prompt = 'deberia hacer WC? me tiran algo que me sirva ahi?';

export default defineEval({
  description:
    'A level 21 mage asks whether Wailing Caverns is worth it; the agent resolves the abbreviation, reads its loot and weighs the level fit and the upgrades.',
  tags: ['dungeons', 'gear'],
  async test(t) {
    const session = await t.session({
      stubs: [...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
    });
    const started = performance.now();
    const turn = await session.send(playerMessage(prompt));
    await saveTurn('wailing-caverns', prompt, turn, performance.now() - started);
    turn.expectOk();
    const loot = turn.toolCalls.filter((call) => call.name === 'wow__dungeon_loot');
    t.check(
      loot.map((call) => call.input),
      satisfies(
        (inputs: unknown[]) =>
          inputs.some((input) => (input as { instanceMapId?: number }).instanceMapId === 43),
        'reads Wailing Caverns loot by its map ID',
      ),
    );
    t.notCalledTool('web__web_search').soft();
    t.maxToolCalls(6).soft();
    const reply = turn.reply ?? '';
    const presented = JSON.stringify(
      turn.toolCalls.filter((call) => call.name === 'wisp__present_ui').map((call) => call.input),
    );
    t.check(
      reply + presented,
      satisfies(
        (text: string) =>
          /Slime-encrusted Pads|Snake Eye Kaleidoscope|Deep Fathom Ring|"id":(6461|273088|6463)/i.test(
            text,
          ),
        'names drops that fill his empty slots',
      ),
    );
    t.check(
      reply,
      satisfies(
        (text: string) =>
          /(^|[^\p{L}])s[ií]([^\p{L}]|$)|vale la pena|te conviene|recomiend|yo (la )?har[ií]a/iu.test(
            text,
          ),
        'answers whether to go',
      ),
    ).soft();
    t.check(
      reply + presented,
      satisfies(
        (text: string) =>
          !/Armor of the Fang|Leggings of the Fang|Venomstrike|Stinging Viper/i.test(text),
        'does not recommend gear a mage cannot use',
      ),
    );
  },
});
