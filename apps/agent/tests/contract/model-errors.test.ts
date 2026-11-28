import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { normalizeModelError, safeErrorMessage } from '../../src/contract/model-errors.ts';

const body = (response: Response) => Effect.promise((): Promise<unknown> => response.json());

it.effect(
  'subscription error details become SDK-readable messages without losing HTTP status',
  () =>
    Effect.gen(function* () {
      const error = yield* normalizeModelError(
        Response.json({ detail: 'Unsupported parameter: example' }, { status: 400 }),
      );
      expect(error.status).toBe(400);
      expect(yield* body(error)).toEqual({ error: { message: 'Unsupported parameter: example' } });
      const quota = yield* normalizeModelError(
        Response.json(
          { error: { message: 'Plan usage limit reached' } },
          { status: 429, headers: { 'retry-after': '60' } },
        ),
      );
      expect(quota.status).toBe(429);
      expect(quota.headers.get('retry-after')).toBe('60');
      expect(quota.headers.has('retry-after')).toBe(true);
      const redacted = yield* normalizeModelError(
        Response.json({ error: { message: 'Rejected Bearer secret-token' } }, { status: 401 }),
      );
      expect(yield* body(redacted)).toEqual({ error: { message: 'Rejected Bearer [redacted]' } });
      expect(redacted.headers.has('retry-after')).toBe(false);
    }),
);

it.effect('responses without an error message come back unchanged and unread', () =>
  Effect.gen(function* () {
    const stream = new Response('data: event\n\n');
    expect(yield* normalizeModelError(stream)).toBe(stream);
    const plain = new Response('Gateway unavailable', { status: 503 });
    expect(yield* normalizeModelError(plain)).toBe(plain);
    expect(plain.bodyUsed).toBe(false);
    // A message that is not text, even beside a `detail`, is left to the SDK.
    const numeric = Response.json({ error: { message: 5 }, detail: 'Ignored' }, { status: 400 });
    expect(yield* normalizeModelError(numeric)).toBe(numeric);
    const listed = Response.json(['Unexpected'], { status: 500 });
    expect(yield* normalizeModelError(listed)).toBe(listed);
  }),
);

it('displayed errors are bounded and remove bearer credentials', () => {
  expect(safeErrorMessage('Rejected Bearer private-access-token')).toBe(
    'Rejected Bearer [redacted]',
  );
  expect(safeErrorMessage('  First\nsecond  ')).toBe(' First second ');
  expect(safeErrorMessage('x'.repeat(2000))).toHaveLength(500);
});
