import { test } from 'vitest';
import assert from 'node:assert/strict';
import { actionSchema, macroBodyError } from '@wisp/protocol/game-actions';
test('action schemas reject invalid coordinates, arbitrary commands and overlong UTF-8 macro text', () => {
  assert.equal(
    macroBodyError('#showtooltip\n/cast [@mouseover,help,nodead][] Frostbolt'),
    undefined,
  );
  for (const body of [
    '/run print(1)',
    '/script x=1',
    '/click Button',
    '/say hello',
    '/cast Frostbolt\n/run print(1)',
    'hello',
    '   ',
  ]) {
    assert.ok(macroBodyError(body));
  }
  assert.throws(() =>
    actionSchema.parse({
      kind: 'set_waypoint',
      args: { mapId: 1, x: 101, y: 50, label: 'NPC', source: 'user' },
    }),
  );
  assert.throws(() =>
    actionSchema.parse({
      kind: 'create_macro',
      args: { name: 'Macro', body: '/cast ' + 'é'.repeat(125) },
    }),
  );
  assert.throws(() =>
    actionSchema.parse({ kind: 'create_macro', args: { name: '   ', body: '/cast Frostbolt' } }),
  );
  assert.throws(() => actionSchema.parse({ kind: 'move', args: {} }));
});
