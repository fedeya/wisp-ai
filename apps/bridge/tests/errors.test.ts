import { expect, test } from 'vitest';
import { HostError } from '@wisp/agent/engine';
import { errorMessage } from '../src/errors.ts';

test("an error without a message reports its cause's", () => {
  const failure = new HostError({ cause: new TypeError('entry.isDirectory is not a function') });
  expect(errorMessage(failure)).toBe('entry.isDirectory is not a function');
  expect(errorMessage(new Error('Plain failure'))).toBe('Plain failure');
});
