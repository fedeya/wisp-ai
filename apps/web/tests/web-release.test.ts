import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getLatestRelease } from '../src/release.server.ts';
import { GET } from '../src/app/download/route.ts';

const repository = 'https://github.com/fedeya/wisp-ai';

function manifest(version: string) {
  return {
    version,
    platforms: {
      'windows-x86_64': {
        url: `${repository}/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`,
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('download follows the published manifest as new releases arrive', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const version of ['0.0.3', '0.0.4']) {
    const release = manifest(version);
    fetch.mockResolvedValueOnce(Response.json(release));
    const response = await GET();
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(release.platforms['windows-x86_64'].url);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(fetch).toHaveBeenCalledWith(
    `${repository}/releases/latest/download/latest.json`,
    expect.objectContaining({ next: { revalidate: 300, tags: ['github-releases'] } }),
  );
});

test('displayed version comes from the same manifest as the installer', async () => {
  const release = manifest('0.0.3');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(release)));
  expect(await getLatestRelease()).toEqual({
    version: '0.0.3',
    download: release.platforms['windows-x86_64'].url,
  });
});

test.each([
  ['HTTP failure', () => Promise.resolve(new Response(null, { status: 503 }))],
  ['network failure', () => Promise.reject(new Error('offline'))],
  ['invalid JSON', () => Promise.resolve(new Response('not JSON'))],
  ['missing installer', () => Promise.resolve(Response.json({ version: '0.0.3' }))],
  ['invalid version', () => Promise.resolve(Response.json(manifest('invalid')))],
  [
    'untrusted installer',
    () =>
      Promise.resolve(
        Response.json({
          version: '0.0.3',
          platforms: { 'windows-x86_64': { url: 'https://example.com/installer.exe' } },
        }),
      ),
  ],
])('%s falls back to the latest release page', async (_label, response) => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(response));
  const result = await GET();
  expect(result.status).toBe(307);
  expect(result.headers.get('Location')).toBe(`${repository}/releases/latest`);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(await getLatestRelease()).toBeNull();
});
