import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newerStable, nightlyBuildVersion, syncVersion } from '../release-version.ts';
import { stableNotes, validateNotes, type GitHubRelease } from '../release-notes.ts';
import { recordStableRelease } from '../record-stable-release.ts';
import {
  latestStable,
  resolveStableRelease,
  stableFromNightly,
} from '../resolve-stable-release.ts';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wisp-release-'));
  for (const path of [
    'apps/desktop/src-tauri',
    'packages/releases',
    'scripts',
    'tests',
    'addon',
    'releases/unreleased',
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
  await copyFile(resolve('.changie.yaml'), join(root, '.changie.yaml'));
  return root;
}
const fragment = (root: string, name: string, kind: string, body: string, time: string) =>
  writeFile(
    join(root, 'releases/unreleased', `${name}.yaml`),
    `kind: ${kind}\nbody: ${body}\ntime: ${time}\n`,
  );

test('nightly builds have unique ordered identities without changing stable versions', () => {
  expect(nightlyBuildVersion('0.1.9', '123', '2')).toBe('0.1.10-nightly.123.2');
  expect(() => nightlyBuildVersion('0.1.9-nightly.1', '123', '1')).toThrow();
});

test('stable notes group Changie fragments by kind and leave them in place', async () => {
  const root = await fixture();
  await expect(async () => stableNotes('0.0.8', root)).rejects.toThrow('pnpm changie new');
  await fragment(root, 'Fixed-2', 'Fixed', 'Reconnect without restarting.', '2026-11-02T00:00:00Z');
  await fragment(root, 'Improved-1', 'Improved', 'Faster **answers**.', '2026-11-01T00:00:00Z');
  await fragment(root, 'Fixed-1', 'Fixed', 'Chats keep their font.', '2026-11-01T00:00:00Z');
  expect(stableNotes('0.0.8', root)).toBe(
    "# What's new in Wisp\n\n## Improved\n\n- Faster **answers**.\n\n## Fixed\n\n- Chats keep their font.\n- Reconnect without restarting.\n",
  );
  expect(await exists(join(root, 'releases/unreleased/Fixed-1.yaml'))).toBe(true);
  expect(() => stableNotes('0.0.8-nightly.1.1', root)).toThrow('X.Y.Z');
});

test('versions synchronize across every app manifest', async () => {
  const root = await fixture();
  await syncVersion('0.0.8', root);
  expect(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version).toBe(
    '0.0.8',
  );
  const lock = await readFile(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  expect(lock).toContain('name = "wisp"\nversion = "0.0.8"');
  expect(lock).toContain('name = "other"\nversion = "1.2.3"');
  expect(validateNotes('# Next\n\n<!-- comment -->\n\n## New\n\n- Item\n')).toBe(
    '# Next\n\n## New\n\n- Item\n',
  );
  expect(() => validateNotes('# Next\n<!-- unfinished -->')).toThrow('user-facing');
});

test('a stable promotion takes the Nightly version unless one is given, newer than the last', () => {
  expect(stableFromNightly('v0.3.3-nightly.214.1')).toBe('0.3.3');
  expect(() => stableFromNightly('v0.3.3')).toThrow('Nightly');
  expect(latestStable(['v0.3.10', 'v0.3.9', 'v0.4.0-nightly.1.1', 'nightly', ''])).toBe('v0.3.10');
  expect(latestStable([])).toBeUndefined();
  expect(newerStable('0.3.10', '0.3.9')).toBe(true);
  expect(newerStable('0.3.2', '0.3.2')).toBe(false);
  expect(newerStable('0.4.0', '1.0.0')).toBe(false);
});

test(
  'a stable promotion resolves a published Nightly from main and refuses taken versions',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wisp-promote-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    const commit = (message: string) =>
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        message,
      );
    git('init');
    commit('stable');
    git('tag', 'v0.3.2');
    commit('first nightly');
    const promoted = git('rev-parse', 'HEAD');
    git('tag', 'v0.3.3-nightly.1.1');
    commit('second nightly');
    git('tag', 'v0.3.3-nightly.2.1');
    commit('main after the last nightly');
    const main = git('rev-parse', 'HEAD');

    const release = (tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
      tag_name: tag,
      draft: false,
      prerelease: tag.includes('-'),
      published_at: '2026-11-20T00:00:00Z',
      assets: [{ name: 'latest.json' }, { name: `WispAI-${tag.slice(1)}-windows-x64-setup.exe` }],
      ...extra,
    });
    // The second page proves the existing-release check reads every page.
    const pages = (...last: GitHubRelease[]) => {
      const first = [
        release('v0.3.3-nightly.2.1'),
        release('v0.3.3-nightly.1.1'),
        ...Array.from({ length: 98 }, (_, index) => release(`v0.2.0-nightly.${index}.1`)),
      ];
      const fetch = vi
        .fn()
        .mockImplementation(async (url: string) =>
          Response.json(url.endsWith('page=1') ? first : [release('v0.3.2'), ...last]),
        );
      vi.stubGlobal('fetch', fetch);
    };
    try {
      pages();
      expect(await resolveStableRelease(main, {}, root)).toEqual({
        sha: git('rev-parse', 'v0.3.3-nightly.2.1^{commit}'),
        version: '0.3.3',
        nightly: 'v0.3.3-nightly.2.1',
      });
      expect(
        await resolveStableRelease(main, { nightly: 'v0.3.3-nightly.1.1', version: '0.4.0' }, root),
      ).toEqual({ sha: promoted, version: '0.4.0', nightly: 'v0.3.3-nightly.1.1' });
      await expect(
        resolveStableRelease(main, { nightly: 'v0.3.3-nightly.9.1' }, root),
      ).rejects.toThrow('not a published Nightly built from main');
      await expect(resolveStableRelease(main, { version: '0.3.2' }, root)).rejects.toThrow(
        'newer than v0.3.2',
      );
      await expect(resolveStableRelease(main, { version: '0.4' }, root)).rejects.toThrow('X.Y.Z');

      pages(release('v0.3.3', { draft: true, published_at: null }));
      await expect(resolveStableRelease(main, {}, root)).rejects.toThrow('existing v0.3.3 draft');
      pages(release('v0.3.3'));
      await expect(resolveStableRelease(main, {}, root)).rejects.toThrow('already released');
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test(
  'recording a published release archives its notes and removes only the fragments it shipped',
  { timeout: 30000 },
  async () => {
    const root = await fixture();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    const commit = (message: string) => {
      git('add', '-A');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        message,
      );
    };
    git('init');
    git('config', 'core.autocrlf', 'false');
    await fragment(root, 'Fixed-1', 'Fixed', 'Shipped fix.', '2026-11-01T00:00:00Z');
    commit('fix: shipped');
    git('tag', 'v0.0.8');
    await fragment(
      root,
      'New-1',
      'New',
      'Merged after the promoted Nightly.',
      '2026-11-03T00:00:00Z',
    );
    commit('feat: later');

    const published =
      "# What's new in Wisp\r\n\r\n## Fixed\r\n\r\n- Shipped fix, edited on GitHub.\r\n";
    expect(await recordStableRelease('v0.0.8', published, root)).toEqual([
      'releases/unreleased/Fixed-1.yaml',
    ]);
    expect(await readFile(join(root, 'releases/0.0.8.md'), 'utf8')).toBe(
      "# What's new in Wisp\n\n## Fixed\n\n- Shipped fix, edited on GitHub.\n",
    );
    expect(await exists(join(root, 'releases/unreleased/Fixed-1.yaml'))).toBe(false);
    expect(await exists(join(root, 'releases/unreleased/New-1.yaml'))).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.0.8');

    // Recording an older release never moves main's version back.
    git('tag', 'v0.0.6', 'HEAD');
    await recordStableRelease('v0.0.6', published, root);
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.0.8');
    await expect(recordStableRelease('v0.0.9-nightly.1.1', published, root)).rejects.toThrow(
      'stable tag',
    );
  },
);
