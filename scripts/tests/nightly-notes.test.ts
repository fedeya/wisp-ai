import { expect, test, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  formatNightlyNotes,
  nightlyNotes,
  previousPublishedNightly,
  validateNotes,
} from '../release-notes.ts';

afterEach(() => vi.unstubAllGlobals());

const sha = 'a'.repeat(40);
const authored =
  '# Next release\n\n<!-- private drafting note -->\n\n## Fixed\n\n- Conversations reconnect without restarting Wisp.\n';

test('nightly release notes contain a technical list and exact comparison link', () => {
  const notes = formatNightlyNotes(sha, 'v0.0.7', '- test: added regression coverage');
  expect(notes).not.toContain('Nightly preview');
  expect(notes).not.toContain('Experimental build from main');
  expect(notes).not.toContain('## Fixed');
  expect(notes).toContain(
    `[View full diff on GitHub](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
  );
  expect(notes).toMatch(/^# Changes since v0.0.7\n/);
  expect(notes).toContain('- test: added regression coverage');
  expect(validateNotes(notes)).toBe(notes);
});

test('nightly notes link to their source when there is no Stable comparison base', () => {
  const notes = formatNightlyNotes(sha);
  expect(notes).toContain(`/commit/${sha}`);
  expect(validateNotes(notes)).toBe(notes);
});

test('malformed source identities fail explicitly', () => {
  expect(() => formatNightlyNotes('bad sha')).toThrow('identity');
  expect(() => formatNightlyNotes(sha, 'nightly')).toThrow('identity');
});

test('incremental Nightly notes retain a separate cumulative Stable comparison', () => {
  const notes = formatNightlyNotes(sha, 'v0.0.8-nightly.1.1', '- Fixed reconnects.', 'v0.0.7');
  expect(notes).toMatch(/^# Changes since v0.0.8-nightly.1.1\n/);
  expect(notes).toContain(`/compare/v0.0.8-nightly.1.1...${sha}`);
  expect(notes).toContain(
    `[All changes since v0.0.7](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
  );
});

test(
  'nightly generation includes technical commits through the exact build without authored notes',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wisp-nightly-notes-'));
    if (!root.startsWith(resolve(tmpdir()) + sep)) {
      throw Error('Unsafe fixture directory.');
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      await mkdir(join(root, 'releases'));
      await writeFile(join(root, 'releases/next.md'), authored);
      git('init');
      git('add', '.');
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
      commit('Initial stable');
      const initialSha = git('rev-parse', 'HEAD');
      const withoutStable = await nightlyNotes(initialSha, root);
      expect(withoutStable).toContain('- Initial stable');
      expect(withoutStable).toContain(`/commit/${initialSha}`);
      git('tag', 'v0.0.7');
      expect(await nightlyNotes(initialSha, root)).toContain('No commits in this comparison.');
      commit('test: added regression coverage');
      git('tag', 'v0.0.8-nightly.1.1');
      commit('fix: retained change from failed build');
      git('tag', 'v0.0.8-nightly.2.1');
      git('tag', 'v0.0.8-nightly.2.2');
      commit('fix: latest change');
      const buildSha = git('rev-parse', 'HEAD');
      git('tag', 'v0.0.8-nightly.3.1');
      commit('docs: update README');
      git('tag', 'v9.0.0');
      git('tag', 'v0.0.8-nightly.2.9');
      await rm(join(root, 'releases/next.md'));
      const notes = await nightlyNotes(buildSha, root);
      expect(notes).toContain(`/compare/v0.0.7...${buildSha}`);
      expect(notes).not.toContain('v9.0.0');
      expect(notes).toContain('test: added regression coverage');
      expect(notes).toContain(`/commit/${buildSha}`);
      expect(notes).not.toContain('README');
      expect(notes).not.toContain('Conversations reconnect');
      expect(notes).not.toContain('Experimental build from main');

      const published = (version: string) => ({
        tag_name: `v${version}`,
        draft: false,
        prerelease: true,
        published_at: '2026-11-10T00:00:00Z',
        assets: [{ name: 'latest.json' }, { name: `WispAI-${version}-windows-x64-setup.exe` }],
      });
      const successful = published('0.0.8-nightly.1.1');
      const releases = [
        published('0.0.8-nightly.3.1'),
        published('0.0.8-nightly.2.9'), // not an ancestor of this build
        { ...published('0.0.8-nightly.2.2'), assets: [] },
        { ...published('0.0.8-nightly.2.1'), draft: true },
        successful,
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => Response.json(releases)),
      );
      const previous = await previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root);
      expect(previous).toBe('v0.0.8-nightly.1.1');
      const incremental = await nightlyNotes(buildSha, root, previous);
      expect(incremental).not.toContain('added regression coverage');
      expect(incremental).toContain('retained change from failed build');
      expect(incremental).toContain('latest change');
      expect(incremental).toContain('All changes since v0.0.7');

      const paginated = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(Array.from({ length: 100 }, () => ({ ...successful, draft: true }))),
        )
        .mockResolvedValueOnce(Response.json([successful]));
      vi.stubGlobal('fetch', paginated);
      expect(await previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root)).toBe(
        successful.tag_name,
      );
      expect(paginated).toHaveBeenCalledTimes(2);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => Response.json([])),
      );
      expect(await previousPublishedNightly('0.0.8-nightly.1.1', initialSha, root)).toBeUndefined();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
      await expect(previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root)).rejects.toThrow(
        'GitHub 503',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
