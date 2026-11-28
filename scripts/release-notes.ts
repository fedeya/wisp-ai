// @effect-migrated
// Release notes: Changie fragments for Stable, the commits since the last
// published Nightly otherwise, and the GitHub releases they are compared with.
import { newerNightly, nightlyVersion, stableVersion } from '@wisp/releases';
import { Effect, Option, Path, Schema, Stream } from 'effect';
import { execute, output } from './child-process.ts';
import { GitHubReleases } from './github-releases.ts';
import type { GitHubRelease } from './github-releases.ts';

export class ReleaseNotesError extends Schema.TaggedError<ReleaseNotesError>()(
  'ReleaseNotesError',
  { message: Schema.String },
) {}

/** Notes with a heading and at least one item, without comments; fails when they have none. */
export const validateNotes = Effect.fnUntraced(function* (notes: string) {
  // Removing a comment can leave a run of blank lines, which oxfmt rejects.
  const content = notes
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
  if (!/^# .+/m.test(content) || !/^[-*] \S.+/m.test(content)) {
    return yield* new ReleaseNotesError({
      message: 'Add user-facing release notes with `pnpm changie new` first.',
    });
  }
  return content + '\n';
});

// Collects the unreleased Changie fragments of the checked-out commit without
// deleting them; the finalize workflow archives them on main after publication.
export const stableNotes = Effect.fnUntraced(function* (version: string, root: string) {
  if (!stableVersion.test(version)) {
    return yield* new ReleaseNotesError({ message: 'Stable release requires X.Y.Z.' });
  }
  const path = yield* Path.Path;
  const changie = yield* path.fromFileUrl(new URL(import.meta.resolve('changie/npm/changie.js')));
  return yield* validateNotes(
    yield* output(process.execPath, [changie, 'batch', version, '--dry-run'], { cwd: root }),
  );
});

/** The newest Stable tag `sha` contains, if any. */
export const latestStableTag = (sha: string, root: string) =>
  output(
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
    { cwd: root },
  ).pipe(
    Effect.map((tag) => Option.some(tag.trim())),
    // A repository without a stable tag can still link to the exact source.
    Effect.catchTag('CommandFailed', () => Effect.succeedNone),
  );

const sourceIdentity = /^[a-f0-9]{40}$/;
const invalidIdentity = () =>
  new ReleaseNotesError({ message: 'Invalid Nightly source identity.' });

/** Whether the commit `ancestor` names is `sha` or one of its ancestors. */
const isAncestor = Effect.fnUntraced(function* (ancestor: string, sha: string, root: string) {
  const completed = yield* execute('git', ['merge-base', '--is-ancestor', ancestor, sha], {
    cwd: root,
  });
  if (completed.exitCode === 0 || completed.exitCode === 1) {
    return completed.exitCode === 0;
  }
  return yield* new ReleaseNotesError({
    message: `Cannot compare ${ancestor} with ${sha}: ${completed.stderr.trim()}`,
  });
});

// The newest published Nightly whose source is `sha` or one of its ancestors.
export const publishedNightly = Effect.fnUntraced(function* (
  sha: string,
  root: string,
  accept: (candidate: string) => boolean = () => true,
) {
  if (!sourceIdentity.test(sha)) {
    return yield* invalidIdentity();
  }
  const releases = yield* GitHubReleases;
  const firstAncestor = Effect.fnUntraced(function* (page: readonly GitHubRelease[]) {
    const candidates = page
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
      if (yield* isAncestor(candidate.tag_name, sha, root)) {
        return Option.some(candidate.tag_name);
      }
    }
    return Option.none<string>();
  });
  const found = yield* releases.pages.pipe(
    Stream.mapEffect(firstAncestor),
    Stream.filter(Option.isSome),
    Stream.runHead,
  );
  return Option.flatten(found);
});

/** The newest published Nightly built from `sha` or before it that is older than `version`. */
export const previousPublishedNightly = Effect.fnUntraced(function* (
  version: string,
  sha: string,
  root: string,
) {
  if (!nightlyVersion.test(version)) {
    return yield* invalidIdentity();
  }
  return yield* publishedNightly(sha, root, (candidate) => newerNightly(version, candidate));
});

export const formatNightlyNotes = Effect.fnUntraced(function* (
  sha: string,
  previous?: string,
  changes: string = '',
  stable?: string,
) {
  if (
    !sourceIdentity.test(sha) ||
    (previous &&
      !(stableVersion.test(previous.slice(1)) || nightlyVersion.test(previous.slice(1)))) ||
    (previous && !previous.startsWith('v')) ||
    (stable && !/^v\d+\.\d+\.\d+$/.test(stable))
  ) {
    return yield* invalidIdentity();
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
});

/** The commits since the previous Nightly, or since the last Stable without one. */
export const nightlyNotes = Effect.fnUntraced(function* (
  sha: string,
  root: string,
  previousNightly: Option.Option<string> = Option.none(),
) {
  const stable = Option.getOrUndefined(yield* latestStableTag(sha, root));
  const previous = Option.getOrUndefined(previousNightly) || stable;
  const changes = yield* output(
    'git',
    [
      'log',
      '--no-merges',
      '--format=- %s ([%h](https://github.com/fedeya/wisp-ai/commit/%H))',
      ...(previous ? [`${previous}..${sha}`] : ['-30', sha]),
    ],
    { cwd: root },
  );
  return yield* formatNightlyNotes(sha, previous, changes, stable);
});
