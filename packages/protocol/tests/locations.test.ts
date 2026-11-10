import { test } from 'vitest';
import { npcLocationsInput } from '@wisp/protocol/game-inspection';
import assert from 'node:assert/strict';
test('NPC lookup inputs remain bounded and cannot select a different database version', () => {
  assert.ok(
    npcLocationsInput.safeParse({ mode: 'services', service: 'Transmogrifier', mapId: 1454 })
      .success,
  );
  assert.ok(
    npcLocationsInput.safeParse({ mode: 'class_trainers', class: 'MAGE', mapId: 1454 }).success,
  );
  for (const input of [
    {},
    { npcId: 0 },
    { mode: 'services' },
    { mode: 'services', service: 'invented' },
    { name: '' },
    { name: 'Deino', version: 'classic' },
    { mode: 'class_trainers', limit: 10000 },
  ]) {
    assert.equal(npcLocationsInput.safeParse(input).success, false);
  }
});
