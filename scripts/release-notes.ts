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
export function nightlyNotes(sha: string) {
  const previous = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/)
    .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const commits = execFileSync(
    'git',
    ['log', '--no-merges', '--format=- %s (%h)', ...(previous ? [`${previous}..HEAD`] : ['-30'])],
    { encoding: 'utf8', windowsHide: true },
  );
  return `# Nightly preview\n\nExperimental build from [${sha.slice(0, 7)}](https://github.com/fedeya/wisp-ai/commit/${sha}).\n\n## Changes since ${previous || 'recent history'}\n\n${commits}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'check') {
    validateNotes(await readFile('releases/next.md', 'utf8'));
  } else {
    await prepareNotes(process.argv[2]);
  }
}
