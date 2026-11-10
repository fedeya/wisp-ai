import { test } from 'vitest';
import assert from 'node:assert/strict';
import { settingsRead, settingsUpdate } from '@wisp/protocol/settings';

test('settings schema bounds scalar preview/apply requests', () => {
  assert.equal(settingsRead.parse({ sections: ['action_bars', 'keybindings'] }).limit, 30);
  assert.throws(() => settingsUpdate.parse({ operation: 'execute', code: 'return 1' }));
  assert.throws(() =>
    settingsUpdate.parse({ operation: 'preview', changes: [{ id: 'x', value: { lua: 'evil' } }] }),
  );
});
