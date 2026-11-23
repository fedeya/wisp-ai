import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nightlyVersion, stableVersion } from '@wisp/releases';
import { githubReleases, publishedNightly } from './release-notes.ts';
import { newerStable } from './release-version.ts';

// A stable release promotes a Nightly that was already published from main, so it
// ships the exact source players on the Nightly channel ran (no newer main commits).
export function stableFromNightly(tag: string) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !nightlyVersion.test(version)) {
    throw Error(`Not a Nightly tag: ${tag}`);
  }
  return version.replace(/-nightly\.\d+\.\d+$/, '');
}
export function latestStable(tags: readonly string[]) {
  return tags
    .filter((tag) => tag.startsWith('v') && stableVersion.test(tag.slice(1)))
    .reduce<string | undefined>(
      (latest, tag) => (!latest || newerStable(tag.slice(1), latest.slice(1)) ? tag : latest),
      undefined,
    );
}

// Picks the Nightly to promote from `main` (the newest published one, or `nightly`)
// and its Stable version (its own X.Y.Z, or `version`), refusing a version that is
// not newer than the last Stable or that already has a release or draft.
export async function resolveStableRelease(
  main: string,
  { nightly: requested, version: chosen }: { nightly?: string; version?: string } = {},
  root = process.cwd(),
) {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const nightly = await publishedNightly(
    main,
    root,
    requested ? (candidate) => `v${candidate}` === requested : undefined,
  );
  if (!nightly) {
    throw Error(
      requested
        ? `${requested} is not a published Nightly built from main.`
        : 'No published Nightly from main to promote.',
    );
  }
  const sha = git('rev-list', '-n', '1', nightly);
  const version = chosen || stableFromNightly(nightly);
  if (!stableVersion.test(version)) {
    throw Error(`Stable versions are X.Y.Z, not ${version}.`);
  }
  const latest = latestStable(git('tag', '--list', 'v*').split('\n'));
  if (latest && !newerStable(version, latest.slice(1))) {
    throw Error(`v${version} must be newer than ${latest}.`);
  }
  for await (const releases of githubReleases()) {
    const existing = releases.find((release) => release.tag_name === `v${version}`);
    if (existing) {
      throw Error(
        existing.draft
          ? `Delete the existing v${version} draft before promoting again.`
          : `v${version} is already released.`,
      );
    }
  }
  return { sha, version, nightly };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw Error('Run the stable release from main.');
  }
  const main = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { sha, version, nightly } = await resolveStableRelease(main, {
    nightly: process.env.NIGHTLY_TAG?.trim(),
    version: process.env.RELEASE_VERSION?.trim(),
  });
  console.log(`Promoting ${nightly} (${sha}) as v${version}.`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `sha=${sha}\nversion=${version}\nnightly=${nightly}\n`,
    );
  }
}
