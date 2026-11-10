import { expect, test, vi, afterEach } from 'vitest';

import {
  publishedRelease,
  getReleaseHistory,
  getPublishedRelease,
} from '../src/changelog.server.ts';
afterEach(() => vi.unstubAllGlobals());
function release(version = '0.1.0', prerelease = false) {
  return {
    tag_name: `v${version}`,
    name: `Wisp ${version}`,
    body: '# Better adventures\n\n- Fixed connections.',
    draft: false,
    prerelease,
    published_at: '2026-11-09T12:00:00Z',
    assets: [
      { name: 'latest.json', browser_download_url: '' },
      {
        name: `WispAI-${version}-windows-x64-setup.exe`,
        browser_download_url: `https://github.com/fedeya/wisp-ai/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`,
      },
    ],
  };
}
test('Nightly links identify the GitHub release independently of links in its notes', () => {
  const value = release('0.1.1-nightly.123.1', true);
  expect(
    publishedRelease({ ...value, body: '[View technical changes on GitHub](https://example.com/)' })
      ?.url,
  ).toBe('https://github.com/fedeya/wisp-ai/releases/tag/v0.1.1-nightly.123.1');
});
test('web only shows published, complete releases in their matching channel', async () => {
  expect(publishedRelease(release())?.title).toBe('v0.1.0');
  const notes =
    '## Fixed\n\n- Fixed an error that prevented the first conversation from starting when no additional MCP servers were configured.';
  expect(publishedRelease({ ...release('0.0.7'), body: notes })?.notes).toBe(notes);
  expect(publishedRelease({ ...release(), draft: true })).toBeNull();
  expect(publishedRelease({ ...release(), assets: [] })).toBeNull();
  expect(publishedRelease(release('0.1.1-nightly.123.1', false))).toBeNull();
  expect(publishedRelease(release('0.1.1-nightly.123.1', true))?.channel).toBe('nightly');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json([
          release(),
          release('0.1.1-nightly.123.1', true),
          { ...release(), draft: true },
        ]),
      ),
  );
  expect((await getReleaseHistory('stable')).releases.map((r) => r.version)).toEqual(['0.1.0']);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  expect((await getReleaseHistory('nightly')).unavailable).toBe(true);
  await expect(getPublishedRelease('0.1.0')).rejects.toThrow('temporarily');
});
test('stable history skips pages filled by nightly builds', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(Array.from({ length: 100 }, () => release('0.1.1-nightly.123.1', true))),
    )
    .mockResolvedValueOnce(Response.json([release()]));
  vi.stubGlobal('fetch', fetch);
  const history = await getReleaseHistory('stable');
  expect(history.releases.map((entry) => entry.version)).toEqual(['0.1.0']);
  expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('page=2'), expect.anything());
  expect(history.more).toBe(false);
});
test('history paginates ten matching releases without losing entries between pages', async () => {
  const stable = Array.from({ length: 25 }, (_, index) => release(`0.2.${25 - index}`));
  const raw = stable.flatMap((entry, index) => [
    release(`0.3.0-nightly.${index + 1}.1`, true),
    { ...entry, draft: true },
    entry,
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => Response.json(raw)),
  );
  const first = await getReleaseHistory('stable', 1);
  const second = await getReleaseHistory('stable', 2);
  const last = await getReleaseHistory('stable', 3);
  expect(first.releases).toHaveLength(10);
  expect(second.releases).toHaveLength(10);
  expect(last.releases).toHaveLength(5);
  expect(first.more).toBe(true);
  expect(second.nextPage).toBe(3);
  expect(last.more).toBe(false);
  expect(
    [...first.releases, ...second.releases, ...last.releases].map((entry) => entry.version),
  ).toEqual(stable.map((entry) => entry.tag_name.slice(1)));
});
