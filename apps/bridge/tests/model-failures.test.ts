import { expect, test } from 'vitest';
import {
  ModelFailures,
  httpFailureKind,
  modelSource,
  thrownFailureKind,
} from '../src/models/model-failures.ts';
import { ChatGPTAuthError } from '../src/auth/chatgpt-auth.ts';

test('provider HTTP statuses map to fixed failure kinds', () => {
  expect([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].map(httpFailureKind)).toEqual([
    'bad_request',
    'auth',
    'auth',
    'not_found',
    'http_other',
    'bad_request',
    'bad_request',
    'rate_limited',
    'provider_error',
    'provider_error',
  ]);
});

test('thrown proxy errors are classified without reading their messages', () => {
  expect(thrownFailureKind(new DOMException('Private', 'TimeoutError'))).toBe('timeout');
  expect(thrownFailureKind(new TypeError('fetch failed'))).toBe('network');
  expect(thrownFailureKind(new ChatGPTAuthError('Private account'))).toBe('auth');
  expect(thrownFailureKind(new Error('Choose a configured model.'))).toBe('wisp_rejected');
  // Eve abandoning a request is not a failure.
  expect(thrownFailureKind(new DOMException('Private', 'AbortError'))).toBeUndefined();
  expect(thrownFailureKind(new TypeError('x'), AbortSignal.abort())).toBeUndefined();
});

test('failures are kept per connection and only count from a given time', () => {
  const failures = new ModelFailures();
  const id = '00000000-0000-4000-8000-000000000001';
  expect(modelSource('connection:' + id + ':model')).toBe(id);
  expect(modelSource('gpt-test')).toBe('chatgpt');
  failures.record(id, 'not_found');
  failures.record('chatgpt', undefined);
  expect(failures.since(id, 0)).toBe('not_found');
  expect(failures.since('other', 0)).toBeUndefined();
  expect(failures.since('chatgpt', 0)).toBeUndefined();
  const later = performance.now() + 60_000;
  expect(failures.since(id, later)).toBeUndefined();
});
