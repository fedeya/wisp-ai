import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { settingsRead, settingsUpdate } from '../../src/contract/settings.ts';

it('settings schema bounds scalar preview/apply requests', () => {
  const read = Schema.decodeUnknownSync(settingsRead)({ sections: ['action_bars', 'keybindings'] });
  expect(read.limit).toBe(30);
  expect(() => settingsUpdate.parse({ operation: 'execute', code: 'return 1' })).toThrow();
  expect(() =>
    settingsUpdate.parse({ operation: 'preview', changes: [{ id: 'x', value: { lua: 'evil' } }] }),
  ).toThrow();
});
