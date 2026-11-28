import { expect, it } from '@effect/vitest';
import { errorText } from '../src/execution/engine-errors.ts';

it('an error reads as its message, and anything else as JSON or a fallback', () => {
  expect(errorText(new Error('The disk is full.'))).toBe('The disk is full.');
  expect(errorText('Rate limited')).toBe('Rate limited');
  expect(errorText({ code: 'overloaded', retry: 2 })).toBe('{"code":"overloaded","retry":2}');
  expect(errorText(429)).toBe('429');
  expect(errorText(null)).toBe('The response failed.');
  expect(errorText(undefined)).toBe('The response failed.');
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(errorText(cycle)).toBe('The response failed.');
  expect(errorText(10n)).toBe('The response failed.');
});
