import { readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableVersion, nightlyVersion, newerNightly } from '@wisp/releases';

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
type NightlyRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string }[];
};

export async function previousPublishedNightly(version: string, sha: string, root = process.cwd()) {
  if (!nightlyVersion.test(version) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw Error('Invalid Nightly source identity.');
  }
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/fedeya/wisp-ai/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      throw Error(`Cannot determine the previous published Nightly: GitHub ${response.status}.`);
    }
    const releases: NightlyRelease[] = await response.json();
    const candidates = releases
      .filter((release) => {
        const candidate = release.tag_name.slice(1);
        return (
          release.tag_name.startsWith('v') &&
          nightlyVersion.test(candidate) &&
          !release.draft &&
          release.prerelease &&
          !!release.published_at &&
          newerNightly(version, candidate) &&
          release.assets.some((asset) => asset.name === 'latest.json') &&
          release.assets.some((asset) => asset.name === `WispAI-${candidate}-windows-x64-setup.exe`)
        );
      })
      .sort((a, b) => (newerNightly(a.tag_name.slice(1), b.tag_name.slice(1)) ? -1 : 1));
    for (const candidate of candidates) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', candidate.tag_name, sha], {
          cwd: root,
          windowsHide: true,
          stdio: 'pipe',
        });
        return candidate.tag_name;
      } catch (error) {
        if ((error as { status?: number }).status !== 1) {
          throw error;
        }
      }
    }
    if (releases.length < 100) {
      return undefined;
    }
  }
}

export function formatNightlyNotes(sha: string, previous?: string, changes = '', stable?: string) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    (previous &&
      !(stableVersion.test(previous.slice(1)) || nightlyVersion.test(previous.slice(1)))) ||
    (previous && !previous.startsWith('v')) ||
    (stable && !/^v\d+\.\d+\.\d+$/.test(stable))
  ) {
    throw Error('Invalid Nightly source identity.');
  }
  const repository = 'https://github.com/fedeya/wisp-ai';
  const technical = previous
    ? `${repository}/compare/${previous}...${sha}`
    : `${repository}/commit/${sha}`;
  const heading = previous ? `Changes since ${previous}` : 'Changes';
  const cumulative =
    stable && stable !== previous
      ? `\n[All changes since ${stable}](${repository}/compare/${stable}...${sha})\n`
      : '';
  return `# ${heading}\n\n${changes.trim() || '- No commits in this comparison.'}\n\n[View full diff on GitHub](${technical})\n${cumulative}`;
}
export async function nightlyNotes(sha: string, root = process.cwd(), previousNightly?: string) {
  let stable: string | undefined;
  try {
    stable = execFileSync(
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
  const previous = previousNightly || stable;
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
  return formatNightlyNotes(sha, previous, changes, stable);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'check') {
    validateNotes(await readFile('releases/next.md', 'utf8'));
  } else {
    await prepareNotes(process.argv[2]);
  }
}
