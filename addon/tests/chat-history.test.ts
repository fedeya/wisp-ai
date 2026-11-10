import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chatHistoryInput, inspectionSchema } from '@wisp/protocol/game-inspection';
test('chat schema validates bounded reads', () => {
  assert.deepEqual(chatHistoryInput.parse({}), { channels: [], limit: 30, lastSeconds: 1800 });
  assert(inspectionSchema.safeParse({ kind: 'chat', args: { channels: ['raid'] } }).success);
  for (const input of [{ limit: 51 }, { lastSeconds: 1801 }, { channels: ['addon'] }]) {
    assert(!chatHistoryInput.safeParse(input).success);
  }
});
