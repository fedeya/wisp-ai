import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { formatNightlyNotes, nightlyNotes, validateNotes } from '../scripts/release-notes.ts';

const sha = 'a'.repeat(40);
const authored =
  '# Next release\n\n<!-- private drafting note -->\n\n## Fixed\n\n- Conversations reconnect without restarting Wisp.\n';

test('nightly notes use curated product changes and a separate technical comparison', () => {
  const notes = formatNightlyNotes(authored, sha, 'v0.0.7');
  expect(notes).toContain('## Fixed\n\n- Conversations reconnect without restarting Wisp.');
  expect(notes).toContain('experimental');
  expect(notes).not.toContain('private drafting note');
  expect(notes).not.toContain('# Next release');
  expect(notes).toContain(
    `[View technical changes on GitHub](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
  );
  expect(validateNotes(notes)).toBe(notes);
});

test('an empty notes template states that no user-facing changes are documented', () => {
  const notes = formatNightlyNotes('# Next release\n<!-- - TODO: write a test -->', sha);
  expect(notes).toContain('No user-facing changes have been documented');
  expect(notes).not.toContain('TODO');
  expect(notes).toContain(`/commit/${sha}`);
  expect(validateNotes(notes)).toBe(notes);
});

test('malformed source identities and authored notes fail explicitly', () => {
  expect(() => formatNightlyNotes(authored, 'bad sha')).toThrow('identity');
  expect(() => formatNightlyNotes(authored, sha, 'nightly')).toThrow('identity');
  expect(() => formatNightlyNotes('- Missing title', sha)).toThrow('title');
});

test('nightly generation omits technical commits and compares against a stable ancestor', async () => {
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
    git('tag', 'v0.0.7');
    commit('test: added regression coverage');
    const buildSha = git('rev-parse', 'HEAD');
    commit('docs: update README');
    git('tag', 'v9.0.0');
    const notes = await nightlyNotes(buildSha, root);
    expect(notes).toContain(`/compare/v0.0.7...${buildSha}`);
    expect(notes).not.toContain('v9.0.0');
    expect(notes).not.toContain('added regression');
    expect(notes).not.toContain('README');
    expect(notes).toContain('Conversations reconnect');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
