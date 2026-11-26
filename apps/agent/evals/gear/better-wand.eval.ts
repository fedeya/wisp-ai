import { wispEval } from '../case.ts';
import { calledTool, maxToolCalls, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';

wispEval('better-wand', {
  description:
    'A wand question in Spanish on an English client uses the weapon search instead of guessing names; it keeps one non-English case in the suite.',
  tags: ['gear', 'tiers'],
  question: 'hay alguna varita mejor que la mía que pueda conseguir?',
  stubs: fedrathStubs(),
  gates: [replied(), calledTool('wow__search_weapons', { input: { weaponType: 'wands' } })],
  scorers: [notCalledTool('thewowdb__search_database'), maxToolCalls(10)],
});
