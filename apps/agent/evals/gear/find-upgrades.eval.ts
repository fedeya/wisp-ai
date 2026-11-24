import { defineEval } from '../harness.ts';
import { calledTool, expects, maxToolCalls, notCalledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';

export default defineEval({
  description: 'A level 21 mage asks for upgrades; the agent searches real candidates per slot.',
  tags: ['gear', 'tiers'],
  question: 'find upgrades for me',
  stubs: fedrathStubs(),
  gates: [
    replied(),
    calledTool('wow__search_armor'),
    // Wisp names items through registered references, so check those too.
    expects('recommends searched candidates', (turn) =>
      /"id":(4320|4314|7048)|Spidersilk Boots|Shoulders|Azure Silk Hood/i.test(turn.presented),
    ),
  ],
  scorers: [
    notCalledTool('thewowdb__search_database'),
    maxToolCalls(30),
    expects(
      'does not push the agility neck to a mage',
      (turn) => !/Explorer's Medallion/i.test(turn.reply) || /agility/i.test(turn.reply),
    ),
  ],
});
