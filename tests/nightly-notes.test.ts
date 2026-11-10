import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { formatNightlyNotes, nightlyNotes, validateNotes } from '../scripts/release-notes.ts';

const sha = 'a'.repeat(40);
const authored =
  '# Next release\n\n<!-- private drafting note -->\n\n## Fixed\n\n- Conversations reconnect without restarting Wisp.\n';

test('nightly release notes contain a technical list and exact comparison link', () => {
  const notes = formatNightlyNotes(sha, 'v0.0.7', '- test: added regression coverage');
  expect(notes).toContain('Experimental build from main');
  expect(notes).not.toContain('## Fixed');
  expect(notes).toContain(
    `[View full diff on GitHub](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
  );
  expect(notes).toContain('## Technical changes since v0.0.7');
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

test('nightly generation includes technical commits through the exact build without authored notes', async () => {
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
    const buildSha = git('rev-parse', 'HEAD');
    commit('docs: update README');
    git('tag', 'v9.0.0');
    await rm(join(root, 'releases/next.md'));
    const notes = await nightlyNotes(buildSha, root);
    expect(notes).toContain(`/compare/v0.0.7...${buildSha}`);
    expect(notes).not.toContain('v9.0.0');
    expect(notes).toContain('test: added regression coverage');
    expect(notes).toContain(`/commit/${buildSha}`);
    expect(notes).not.toContain('README');
    expect(notes).not.toContain('Conversations reconnect');
    expect(notes).toContain('Experimental build from main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
