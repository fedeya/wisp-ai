import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import {
  actionParseOptions,
  actionSchema,
  macroBodyError,
} from '../../src/contract/game-actions.ts';
import type { GameAction } from '../../src/contract/game-actions.ts';

const act = (kind: GameAction['kind'], args: unknown) =>
  Schema.decodeUnknownExit(actionSchema)({ kind, args }, actionParseOptions(kind));
const accepts = (kind: GameAction['kind'], args: unknown) => Exit.isSuccess(act(kind, args));
// What a rejected action says, issue messages included.
const rejection = (kind: GameAction['kind'], args: unknown) => String(act(kind, args));

const goal = { type: 'accept', questId: 786, questTitle: 'Thwarting Kolkar Aggression' };
const guideAccepts = (steps: unknown[], extra = {}) =>
  accepts('polestar_guide', { title: 'Kolkar', steps, ...extra });
const largeGuide = (steps: number) => ({
  title: 'Large',
  steps: Array(steps).fill({ goals: Array(8).fill({ type: 'note', text: 'x'.repeat(200) }) }),
});

it('action schemas reject invalid coordinates, control bytes and overlong UTF-8 macro text', () => {
  for (const body of [
    '#showtooltip\n/cast [@mouseover,help,nodead][] Frostbolt',
    '/run print(1)',
    '/script x=1',
    '/click Button',
    '/say hello |cffff0000red|r',
    '/tar Hogger\n/sc Frostbolt',
  ]) {
    expect(macroBodyError(body)).toBeUndefined();
  }
  for (const body of ['   ', '/cast Frostbolt\u0001', 'x'.repeat(256)]) {
    expect(macroBodyError(body)).toBeTruthy();
  }
  expect(accepts('set_waypoint', { mapId: 1, x: 101, y: 50, label: 'NPC', source: 'user' })).toBe(
    false,
  );
  expect(accepts('create_macro', { name: 'Macro', body: '/cast ' + 'é'.repeat(125) })).toBe(false);
  expect(accepts('create_macro', { name: '   ', body: '/cast Frostbolt' })).toBe(false);
  expect(Exit.isFailure(Schema.decodeUnknownExit(actionSchema)({ kind: 'move', args: {} }))).toBe(
    true,
  );
});

it('action schemas fill defaults, trim macro names and drop unknown keys of open arguments', () => {
  expect(
    act('set_waypoint', { mapId: 1, x: 51.9, y: 43.5, label: 'NPC', source: 'user', z: 1 }),
  ).toEqual(
    Exit.succeed({
      kind: 'set_waypoint',
      args: { mapId: 1, x: 51.9, y: 43.5, label: 'NPC', source: 'user', navigate: true },
    }),
  );
  expect(act('create_macro', { name: ' Frost ', body: '/cast Frostbolt' })).toEqual(
    Exit.succeed({
      kind: 'create_macro',
      args: { name: 'Frost', body: '/cast Frostbolt', perCharacter: true },
    }),
  );
  expect(act('clear_waypoint', { pin: 1 })).toEqual(
    Exit.succeed({ kind: 'clear_waypoint', args: {} }),
  );
  expect(act('undo_settings', { transactionId: 't1', force: true })).toEqual(
    Exit.succeed({ kind: 'undo_settings', args: { transactionId: 't1' } }),
  );
});

it('action schemas give the refinement messages zod gave', () => {
  expect(rejection('create_macro', { name: 'Ma|cro', body: '/cast Frostbolt' })).toContain(
    'Use a short plain macro name, up to 16 UTF-8 bytes',
  );
  expect(rejection('create_macro', { name: 'Macro', body: '/cast Frostbolt\u0001' })).toContain(
    'Macro bodies must contain 1–255 UTF-8 bytes of macro text',
  );
  const unpaired = { ...goal, mapId: 1411 };
  expect(
    rejection('polestar_guide', { title: 'Kolkar', steps: [{ goals: [unpaired] }] }),
  ).toContain('Give mapId, x and y together');
});

it('Polestar guide actions require each goal type’s fields and bound the guide', () => {
  expect(act('polestar_guide', { title: ' Kolkar ', steps: [{ goals: [goal] }] })).toEqual(
    Exit.succeed({
      kind: 'polestar_guide',
      args: { title: 'Kolkar', steps: [{ goals: [goal] }], open: true },
    }),
  );
  expect(guideAccepts([{ goals: [{ ...goal, mapId: 1411, x: 51.9, y: 43.5 }] }])).toBe(true);
  expect(guideAccepts([{ goals: [{ type: 'goto', mapId: 1411, x: 50, y: 50 }] }])).toBe(true);
  expect(guideAccepts([{ goals: [{ type: 'note', text: 'Watch for patrols.' }] }])).toBe(true);
  // Required fields per type, paired coordinates, unknown types and fields.
  expect(guideAccepts([{ goals: [{ type: 'accept', questId: 786 }] }])).toBe(false);
  expect(guideAccepts([{ goals: [{ type: 'goto', mapId: 1411, x: 50 }] }])).toBe(false);
  expect(guideAccepts([{ goals: [{ ...goal, mapId: 1411 }] }])).toBe(false);
  expect(guideAccepts([{ goals: [{ ...goal, x: 101, y: 1, mapId: 1 }] }])).toBe(false);
  expect(guideAccepts([{ goals: [{ type: 'teleport' }] }])).toBe(false);
  expect(guideAccepts([{ goals: [{ ...goal, script: 'x' }] }])).toBe(false);
  expect(guideAccepts([{ goals: [goal], script: 'x' }])).toBe(false);
  expect(guideAccepts([{ goals: [goal] }], { script: 'x' })).toBe(false);
  // Size bounds and ids.
  expect(guideAccepts([])).toBe(false);
  expect(guideAccepts([{ goals: [] }])).toBe(false);
  expect(guideAccepts([{ goals: Array(9).fill(goal) }])).toBe(false);
  expect(guideAccepts(Array(31).fill({ goals: [goal] }))).toBe(false);
  expect(guideAccepts([{ goals: [goal] }], { id: 'g1700000000' })).toBe(true);
  expect(guideAccepts([{ goals: [goal] }], { id: 'a'.repeat(32) })).toBe(true);
  const badIds = ['../Bad', 'G1', '-g1', 'a'.repeat(33), 'g1\n'];
  expect(badIds.filter((id) => guideAccepts([{ goals: [goal] }], { id }))).toEqual([]);
});

it('Polestar guides fit the agent action request body', () => {
  const largest = act('polestar_guide', largeGuide(30));
  expect(Exit.isFailure(largest)).toBe(true);
  expect(String(largest)).toMatch(/bytes; keep it under 24576/);
  // The biggest guide the schema accepts still fits the 32 KiB /action body.
  let steps = 30;
  while (!accepts('polestar_guide', largeGuide(steps))) {
    steps -= 1;
  }
  const action = { kind: 'polestar_guide', args: largeGuide(steps) };
  const body = JSON.stringify({ agentSession: 'e'.repeat(64), action });
  expect(Buffer.byteLength(body)).toBeLessThan(32768);
});
