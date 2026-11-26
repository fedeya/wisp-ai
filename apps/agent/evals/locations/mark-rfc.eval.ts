import { defineEval } from '../harness.ts';
import { calledTool, replied } from '../checks.ts';
import { fedrathStubs } from '../fixtures/fedrath.ts';
import { dungeonStubs, noLookupStubs, mapStubs } from '../fixtures/world.ts';

export default defineEval({
  description: 'A map request resolves the destination and places one waypoint.',
  tags: ['tiers'],
  question: 'can you mark the Ragefire Chasm entrance on my map?',
  stubs: [...mapStubs(), ...dungeonStubs(), ...noLookupStubs(), ...fedrathStubs()],
  gates: [replied(), calledTool('wow__set_map_waypoint', { count: 1 })],
});
