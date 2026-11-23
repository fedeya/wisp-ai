import { expect, test } from 'vitest';
import {
  ModelFailures,
  httpFailureKind,
  requestSession,
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

test('failures are kept per session and only count from a given time', () => {
  const failures = new ModelFailures();
  expect(requestSession({ 'x-wisp-session': 'eve-1' })).toBe('eve-1');
  expect(requestSession({ 'x-wisp-session': 'not a session id' })).toBeUndefined();
  expect(requestSession({})).toBeUndefined();
  failures.record('eve-1', 'not_found');
  failures.record('eve-2', undefined);
  failures.record(undefined, 'auth');
  expect(failures.since('eve-1', 0)).toBe('not_found');
  expect(failures.since('eve-2', 0)).toBeUndefined();
  expect(failures.since(undefined, 0)).toBeUndefined();
  expect(failures.since('eve-1', performance.now() + 60_000)).toBeUndefined();
});

test('only recent sessions are kept', () => {
  const failures = new ModelFailures();
  for (let i = 0; i <= 256; i++) failures.record('eve-' + i, 'auth');
  expect(failures.since('eve-0', 0)).toBeUndefined();
  expect(failures.since('eve-1', 0)).toBe('auth');
  expect(failures.since('eve-256', 0)).toBe('auth');
});
