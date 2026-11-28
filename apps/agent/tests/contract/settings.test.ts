import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { settingsRead, settingsUpdate } from '../../src/contract/settings.ts';

it('settings schema bounds scalar preview/apply requests', () => {
  const read = Schema.decodeUnknownSync(settingsRead)({ sections: ['action_bars', 'keybindings'] });
  expect(read.limit).toBe(30);
  const update = Schema.decodeUnknownExit(settingsUpdate);
  expect(Exit.isFailure(update({ operation: 'execute', code: 'return 1' }))).toBe(true);
  expect(
    Exit.isFailure(
      update({ operation: 'preview', changes: [{ id: 'x', value: { lua: 'evil' } }] }),
    ),
  ).toBe(true);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'x'.repeat(1001)]) {
    expect(Exit.isFailure(update({ operation: 'preview', changes: [{ id: 'x', value }] }))).toBe(
      true,
    );
  }
  for (const value of [true, 0.5, 'x'.repeat(1000)]) {
    expect(Exit.isSuccess(update({ operation: 'preview', changes: [{ id: 'x', value }] }))).toBe(
      true,
    );
  }
});
