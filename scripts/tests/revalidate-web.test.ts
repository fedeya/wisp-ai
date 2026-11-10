import { expect, test, vi } from 'vitest';
import { revalidateWeb } from '../revalidate-web.ts';

test('publication invalidates before warming both languages, channels and release details', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async (_url, options) =>
      options?.method === 'POST'
        ? Response.json({ revalidated: true })
        : new Response('Published v0.1.1-nightly.42.1'),
    );
  await revalidateWeb('https://wisp.test', 'secret', 'v0.1.1-nightly.42.1', fetch);
  expect(fetch.mock.calls[0][0].href).toBe('https://wisp.test/api/revalidate');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
    redirect: 'error',
  });
  for (const locale of ['en', 'es']) {
    for (const path of [
      '',
      '/changelog',
      '/changelog?channel=nightly',
      '/opengraph-image',
      '/changelog/0.1.1-nightly.42.1',
    ]) {
      expect(
        fetch.mock.calls.some(([url]) => url.href === `https://wisp.test/${locale}${path}`),
      ).toBe(true);
    }
  }
  expect(fetch.mock.calls.slice(1).every(([, options]) => !options.headers)).toBe(true);
});

test('missing secret, failed invalidation and stale release pages fail the refresh', async () => {
  const fetch = vi.fn();
  await expect(revalidateWeb('https://wisp.test', '', undefined, fetch)).rejects.toThrow(
    'Configure',
  );
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response(null, { status: 401 }));
  await expect(revalidateWeb('https://wisp.test', 'secret', undefined, fetch)).rejects.toThrow(
    '401',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch
    .mockReset()
    .mockImplementation(async (_url, options) =>
      options?.method === 'POST' ? Response.json({ revalidated: true }) : new Response('old data'),
    );
  await expect(revalidateWeb('https://wisp.test', 'secret', 'v0.1.0', fetch)).rejects.toThrow(
    'not visible',
  );
});

test('a failed warmup does not report success', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ revalidated: true }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(revalidateWeb('https://wisp.test', 'secret', undefined, fetch)).rejects.toThrow(
    'Warming /en failed',
  );
});
