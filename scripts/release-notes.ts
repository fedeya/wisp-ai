import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stableVersion, nightlyVersion, newerNightly } from '@wisp/releases';

export function validateNotes(notes: string) {
  // Removing a comment can leave a run of blank lines, which oxfmt rejects.
  const content = notes
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!/^# .+/m.test(content) || !/^[-*] \S.+/m.test(content)) {
    throw Error('Add user-facing release notes with `pnpm changie new` first.');
  }
  return content + '\n';
}
// Collects the unreleased Changie fragments of the checked-out commit without
// deleting them; the finalize workflow archives them on main after publication.
export function stableNotes(version: string, root = process.cwd()) {
  if (!stableVersion.test(version)) {
    throw Error('Stable release requires X.Y.Z.');
  }
  const changie = createRequire(import.meta.url).resolve('changie/npm/changie.js');
  return validateNotes(
    execFileSync(process.execPath, [changie, 'batch', version, '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}
export function latestStableTag(sha: string, root = process.cwd()) {
  try {
    return execFileSync(
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
    return undefined;
  }
}
export type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string }[];
};
// Every release of the repository, drafts included, newest first, one page at a time.
export async function* githubReleases(): AsyncGenerator<GitHubRelease[]> {
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
      throw Error(`Cannot list GitHub releases: GitHub ${response.status}.`);
    }
    const releases: GitHubRelease[] = await response.json();
    yield releases;
    if (releases.length < 100) {
      return;
    }
  }
}

export async function previousPublishedNightly(version: string, sha: string, root = process.cwd()) {
  if (!nightlyVersion.test(version)) {
    throw Error('Invalid Nightly source identity.');
  }
  return publishedNightly(sha, root, (candidate) => newerNightly(version, candidate));
}
// The newest published Nightly whose source is `sha` or one of its ancestors.
export async function publishedNightly(
  sha: string,
  root = process.cwd(),
  accept: (candidate: string) => boolean = () => true,
) {
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw Error('Invalid Nightly source identity.');
  }
  for await (const releases of githubReleases()) {
    const candidates = releases
      .filter((release) => {
        const candidate = release.tag_name.slice(1);
        return (
          release.tag_name.startsWith('v') &&
          nightlyVersion.test(candidate) &&
          !release.draft &&
          release.prerelease &&
          !!release.published_at &&
          accept(candidate) &&
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
  }
  return undefined;
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
  const stable = latestStableTag(sha, root);
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
