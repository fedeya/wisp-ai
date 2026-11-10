import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeModelError, safeErrorMessage } from '@wisp/protocol/model-errors';

test('subscription error details become SDK-readable messages without losing HTTP status', async () => {
  const error = await normalizeModelError(
    Response.json({ detail: 'Unsupported parameter: example' }, { status: 400 }),
  );
  assert.equal(error.status, 400);
  assert.deepEqual(await error.json(), { error: { message: 'Unsupported parameter: example' } });
  const quota = await normalizeModelError(
    Response.json(
      { error: { message: 'Plan usage limit reached' } },
      { status: 429, headers: { 'retry-after': '60' } },
    ),
  );
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get('retry-after'), '60');
  const stream = new Response('data: event\n\n');
  assert.equal(await normalizeModelError(stream), stream);
  const plain = new Response('Gateway unavailable', { status: 503 });
  assert.equal(await normalizeModelError(plain), plain);
});

test('displayed errors are bounded and remove bearer credentials', () => {
  assert.equal(
    safeErrorMessage('Rejected Bearer private-access-token'),
    'Rejected Bearer [redacted]',
  );
  assert.equal(safeErrorMessage('  First\nsecond  '), ' First second ');
  assert.equal(safeErrorMessage('x'.repeat(2000)).length, 500);
});
