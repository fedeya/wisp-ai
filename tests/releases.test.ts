import { expect, test, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nightlyBuildVersion, syncVersion } from '../scripts/release-version.ts';
import { prepareNotes, validateNotes } from '../scripts/release-notes.ts';
import { renderReleaseNotes, newerNightly } from '@wisp/releases';
import {
  publishedRelease,
  getReleaseHistory,
  getPublishedRelease,
} from '../apps/web/src/changelog.server.ts';

afterEach(() => vi.unstubAllGlobals());
test('nightly builds have unique ordered identities without changing stable versions', () => {
  expect(nightlyBuildVersion('0.1.9', '123', '2')).toBe('0.1.10-nightly.123.2');
  expect(() => nightlyBuildVersion('0.1.9-nightly.1', '123', '1')).toThrow();
  expect(newerNightly('0.1.1-nightly.10.1', '0.1.1-nightly.9.1')).toBe(true);
  expect(newerNightly('0.1.1-nightly.9.2', '0.1.1-nightly.10.1')).toBe(false);
});
test('stable preparation consumes user notes once and synchronizes all app versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-release-'));
  for (const path of [
    'apps/desktop/src-tauri',
    'packages/releases',
    'scripts',
    'tests',
    'addon',
    'releases',
  ]) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of [
    'package.json',
    'apps/desktop/package.json',
    'packages/releases/package.json',
    'scripts/package.json',
    'tests/package.json',
    'addon/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ]) {
    await writeFile(join(root, path), '{"version":"0.0.7"}\n');
  }
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '[package]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.lock'),
    '[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'releases/next.md'),
    '# Better adventures\n\n## Fixed\n\n- Reconnect without restarting.\n<!-- internal -->',
  );
  await prepareNotes('0.0.8', root);
  await syncVersion('0.0.8', root);
  expect(await readFile(join(root, 'releases/0.0.8.md'), 'utf8')).not.toContain('internal');
  expect(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version).toBe(
    '0.0.8',
  );
  const lock = await readFile(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  expect(lock).toContain('name = "wisp"\nversion = "0.0.8"');
  expect(lock).toContain('name = "other"\nversion = "1.2.3"');
  expect(() => validateNotes('# Next\n<!-- unfinished -->')).toThrow('user-facing');
  await expect(prepareNotes('0.0.8', root)).rejects.toThrow();
});
test('shared Markdown supports rich notes without executing HTML or unsafe URLs', () => {
  const html = renderReleaseNotes(
    '# Hello\n\n- **Improved** updates\n\n![Preview](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n![x](data:text/html,evil)',
  );
  expect(html).toContain('<strong>Improved</strong>');
  expect(html).toContain('<img src="https://example.com/image.png"');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="data:');
});
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
