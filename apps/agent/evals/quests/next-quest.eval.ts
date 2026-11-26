import { wispEval } from '../case.ts';
import { calledTool, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { questStubs } from '../fixtures/world.ts';

wispEval('next-quest', {
  description: 'Next-quest advice reads the quest log and recommends one suitable quest.',
  tags: ['tiers'],
  question: 'what quests should I do now?',
  stubs: [...questStubs(), ...fedrathStubs()],
  gates: [replied(), calledTool('wow__query_character')],
  scorers: [notCalledTool('web__web_search')],
});
