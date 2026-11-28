import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { simulationInput, simulationNeedsLiveState } from '../../src/contract/simulation.ts';
import { rpcRequests } from '../../src/contract/agent-rpc.ts';

const simulate = (input: unknown) =>
  Schema.decodeUnknownExit(simulationInput)(input, rejectUnknownKeys);
const accepts = (input: unknown) => Exit.isSuccess(simulate(input));
// What a rejected request says, issue messages included.
const rejection = (input: unknown) => String(simulate(input));

const plan = { label: ' Frostbolt ', priority: [{ spellId: 116 }] };

it('simulation requests fill their defaults and trim labels', () => {
  expect(simulate({ plans: [plan], equipmentSets: [{ label: 'Wand', replacements: [] }] })).toEqual(
    Exit.succeed({
      startIndex: 0,
      catalogOnly: false,
      plans: [{ label: 'Frostbolt', opener: [], priority: [{ spellId: 116 }] }],
      includeCurrentEquipment: true,
      equipmentSets: [{ label: 'Wand', base: 'current', replacements: [] }],
      durationSeconds: 30,
      iterations: 500,
      targetLevelOffset: 0,
    }),
  );
  expect(accepts({ nativeRequest: { raid: { parties: [] } } })).toBe(true);
  expect(accepts({ catalogOnly: true })).toBe(true);
});

it('simulation requests are strict at every level and bound their numbers', () => {
  for (const input of [
    { plans: [plan], seed: 1 },
    { plans: [{ ...plan, rotation: 'x' }] },
    { plans: [{ ...plan, priority: [{ spellId: 116, castTime: 1 }] }] },
    { plans: [{ ...plan, talents: [{ id: 1, rank: 1, tier: 1 }] }] },
    { plans: [plan], character: { class: 'MAGE', level: 11, raceToken: 'Human', name: 'x' } },
    {
      plans: [plan],
      equipmentSets: [{ label: 'x', replacements: [{ slot: 1, itemId: 1, x: 1 }] }],
    },
    { plans: [plan], iterations: 0 },
    { plans: [plan], durationSeconds: Number.POSITIVE_INFINITY },
    { plans: [plan], targetLevelOffset: 0.5 },
    { plans: [plan], startIndex: -1 },
    { plans: [plan], targetDistanceYards: -1 },
    { plans: [{ ...plan, label: '  ' }] },
    { plans: [{ ...plan, priority: [{ spellId: 116, manaBelowPercent: 101 }] }] },
    { plans: [{ ...plan, priority: [{ spellId: 116, comboPointsAtLeast: 10 }] }] },
    { plans: [plan], equipmentSets: [{ label: 'x', replacements: [{ slot: 19, itemId: 1 }] }] },
    { plans: [plan], character: { class: 'MONK', level: 11, raceToken: 'Human' } },
    { nativeRequest: [] },
  ]) {
    expect(accepts(input), JSON.stringify(input)).toBe(false);
  }
});

it('simulation requests give the refinement messages zod gave', () => {
  expect(rejection({})).toContain('Provide at least one plan for simulation.');
  expect(rejection({ plans: [plan], includeCurrentEquipment: false })).toContain(
    'Provide at least one equipment set when excluding current equipment.',
  );
});

it('the RPC request adds the agent session and keeps the simulation’s checks', () => {
  const request = rpcRequests.simulate.parse({ agentSession: 'session', plans: [plan] });
  expect(Object.keys(request).at(-1)).toBe('agentSession');
  expect(() => rpcRequests.simulate.parse({ agentSession: 'session' })).toThrow(
    'Provide at least one plan for simulation.',
  );
  expect(() => rpcRequests.simulate.parse({ plans: [plan] })).toThrow();
  expect(() => rpcRequests.simulate.parse({ agentSession: 's', plans: [plan], x: 1 })).toThrow();
});

it('only hypothetical, native and catalog requests skip the live character', () => {
  const decode = (input: unknown) => Schema.decodeUnknownSync(simulationInput)(input);
  const character = { class: 'MAGE', level: 11, raceToken: 'Human' };
  const empty = [{ label: 'Empty', base: 'empty', replacements: [] }];
  expect(simulationNeedsLiveState(decode({ plans: [plan] }))).toBe(true);
  expect(simulationNeedsLiveState(decode({ nativeRequest: {} }))).toBe(false);
  expect(simulationNeedsLiveState(decode({ catalogOnly: true, character }))).toBe(false);
  expect(
    simulationNeedsLiveState(
      decode({ plans: [plan], character, includeCurrentEquipment: false, equipmentSets: empty }),
    ),
  ).toBe(false);
  expect(simulationNeedsLiveState(decode({ plans: [plan], character }))).toBe(true);
});
