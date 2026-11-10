import { expect, test, vi } from 'vitest';
import { revalidateWeb } from '../revalidate-web.ts';

test('publication only sends the invalidation POST without requesting public pages', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ revalidated: true }));
  await revalidateWeb('https://wisp.test', 'secret', undefined, fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0].href).toBe('https://wisp.test/api/revalidate');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
    redirect: 'error',
  });
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('x-vercel-protection-bypass');
});

test('configured Vercel automation bypass is sent together with application authorization', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ revalidated: true }));
  await revalidateWeb('https://wisp.test', 'app-secret', 'vercel-secret', fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].headers).toEqual({
    Authorization: 'Bearer app-secret',
    'x-vercel-protection-bypass': 'vercel-secret',
  });
});

test('missing application secret fails before any request', async () => {
  const fetch = vi.fn();
  await expect(revalidateWeb('https://wisp.test', '', 'vercel-secret', fetch)).rejects.toThrow(
    'Configure',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test.each([401, 403, 503])('HTTP %s fails the invalidation', async (status) => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
  await expect(revalidateWeb('https://wisp.test', 'secret', undefined, fetch)).rejects.toThrow(
    `Web revalidation failed (${status})`,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('an unexpected success response does not report successful invalidation', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ revalidated: false }));
  await expect(revalidateWeb('https://wisp.test', 'secret', undefined, fetch)).rejects.toThrow(
    'Web revalidation failed',
  );
});
