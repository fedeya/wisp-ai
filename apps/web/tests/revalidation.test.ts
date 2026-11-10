import { afterEach, expect, test, vi } from 'vitest';
import { revalidatePath, revalidateTag } from 'next/cache';
import { POST } from '../src/app/api/revalidate/route.ts';
import { getReleaseHistory, getPublishedRelease } from '../src/changelog.server.ts';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('revalidation fails closed without configuration or valid authorization', async () => {
  vi.stubEnv('WEB_REVALIDATION_SECRET', '');
  expect((await POST(new Request('https://wisp.test/api/revalidate'))).status).toBe(503);
  vi.stubEnv('WEB_REVALIDATION_SECRET', 'test-secret');
  for (const authorization of ['', 'Bearer wrong', 'Bearer test-secrex']) {
    const response = await POST(
      new Request('https://wisp.test/api/revalidate', { headers: { authorization } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(revalidateTag).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

test('authorized release publication immediately expires data and rendered pages', async () => {
  vi.stubEnv('WEB_REVALIDATION_SECRET', 'test-secret');
  const response = await POST(
    new Request('https://wisp.test/api/revalidate', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
    }),
  );
  expect(await response.json()).toEqual({ revalidated: true });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(revalidateTag).toHaveBeenCalledWith('github-releases', { expire: 0 });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('release histories and individual entries participate in publication invalidation', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json([]));
  vi.stubGlobal('fetch', fetch);
  await getReleaseHistory('stable');
  await getReleaseHistory('nightly');
  await getPublishedRelease('0.1.0');
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, options] of fetch.mock.calls) {
    expect(options.next).toEqual({ revalidate: 300, tags: ['github-releases'] });
  }
});
