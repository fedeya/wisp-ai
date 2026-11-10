import { readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableVersion } from '@wisp/releases';

export function validateNotes(notes: string) {
  const content = notes.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^# .+/m.test(content) || !/^[-*] \S.+/m.test(content)) {
    throw Error('Write a title and user-facing release notes in releases/next.md first.');
  }
  return content + '\n';
}
const reset =
  "# What's new in Wisp\n\n<!-- Add user-facing notes for the next stable release here. -->\n";
export async function prepareNotes(version: string, root = process.cwd()) {
  if (!stableVersion.test(version)) {
    throw Error('Stable release requires X.Y.Z.');
  }
  const notes = validateNotes(await readFile(resolve(root, 'releases/next.md'), 'utf8'));
  const target = resolve(root, `releases/${version}.md`);
  try {
    await access(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await writeFile(target, notes);
    await writeFile(resolve(root, 'releases/next.md'), reset);
    return;
  }
  throw Error(`Release notes already exist for ${version}.`);
}
export function formatNightlyNotes(sha: string, previous?: string, changes = '') {
  if (!/^[a-f0-9]{40}$/.test(sha) || (previous && !/^v\d+\.\d+\.\d+$/.test(previous))) {
    throw Error('Invalid Nightly source identity.');
  }
  const repository = 'https://github.com/fedeya/wisp-ai';
  const technical = previous
    ? `${repository}/compare/${previous}...${sha}`
    : `${repository}/commit/${sha}`;
  const heading = previous ? `Technical changes since ${previous}` : 'Technical changes';
  return `# Nightly preview\n\n- Experimental build from main. It may contain bugs.\n\n## ${heading}\n\n${changes.trim() || '- No commits in this comparison.'}\n\n[View full diff on GitHub](${technical})\n`;
}
export async function nightlyNotes(sha: string, root = process.cwd()) {
  let previous: string | undefined;
  try {
    previous = execFileSync(
      'git',
      [
        'describe',
        '--tags',
        '--match',
        'v[0-9]*.[0-9]*.[0-9]*',
        '--exclude',
        '*-*',
        '--abbrev=0',
        sha,
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    // A repository without a stable tag can still link to the exact source.
  }
  const changes = execFileSync(
    'git',
    [
      'log',
      '--no-merges',
      '--format=- %s ([%h](https://github.com/fedeya/wisp-ai/commit/%H))',
      ...(previous ? [`${previous}..${sha}`] : ['-30', sha]),
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  return formatNightlyNotes(sha, previous, changes);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'check') {
    validateNotes(await readFile('releases/next.md', 'utf8'));
  } else {
    await prepareNotes(process.argv[2]);
  }
}
