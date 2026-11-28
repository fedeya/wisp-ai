// @effect-migrated
// A stable release promotes a Nightly that was already published from main, so it
// ships the exact source players on the Nightly channel ran (no newer main commits).
//   NIGHTLY_TAG=<tag> RELEASE_VERSION=<X.Y.Z> node scripts/resolve-stable-release.ts
import { nightlyVersion, stableVersion } from '@wisp/releases';
import { Config, Console, Effect, Layer, Option, Path, Schema, Stream } from 'effect';
import { Command } from 'effect/cli';
import { output } from './child-process.ts';
import { writeOutputs } from './github-actions.ts';
import * as GitHub from './github-releases.ts';
import { publishedNightly } from './release-notes.ts';
import { isNewerStable, isStableVersion, newerStable } from './release-version.ts';
import type { StableVersion } from './release-version.ts';
import { runScript } from './run-script.ts';

export class StableReleaseError extends Schema.TaggedError<StableReleaseError>()(
  'StableReleaseError',
  { message: Schema.String },
) {}

/** The Stable version a Nightly tag promotes to: its own X.Y.Z. */
export const stableFromNightly = Effect.fnUntraced(function* (tag: string) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !nightlyVersion.test(version)) {
    return yield* new StableReleaseError({ message: `Not a Nightly tag: ${tag}` });
  }
  return version.replace(/-nightly\.\d+\.\d+$/, '');
});

/** The newest Stable tag among `tags`, if any. */
export function latestStable(tags: readonly string[]): string | undefined {
  let latest: { readonly tag: string; readonly version: StableVersion } | undefined;
  for (const tag of tags) {
    const version = tag.slice(1);
    if (tag.startsWith('v') && isStableVersion(version)) {
      if (!latest || isNewerStable(version, latest.version)) {
        latest = { tag, version };
      }
    }
  }
  return latest?.tag;
}

export interface Requested {
  /** The Nightly tag to promote; the newest published one from main when absent. */
  readonly nightly?: string | undefined;
  /** The Stable version to promote it as; the Nightly's own X.Y.Z when absent. */
  readonly version?: string | undefined;
}

// Picks the Nightly to promote from `main` (the newest published one, or `nightly`)
// and its Stable version (its own X.Y.Z, or `version`), refusing a version that is
// not newer than the last Stable or that already has a release or draft.
export const resolveStableRelease = Effect.fnUntraced(function* (
  main: string,
  { nightly: requested, version: chosen }: Requested,
  root: string,
) {
  const git = (...args: string[]) =>
    output('git', args, { cwd: root }).pipe(Effect.map((text) => text.trim()));
  const found = yield* publishedNightly(
    main,
    root,
    requested ? (candidate) => `v${candidate}` === requested : undefined,
  );
  if (Option.isNone(found)) {
    return yield* new StableReleaseError({
      message: requested
        ? `${requested} is not a published Nightly built from main.`
        : 'No published Nightly from main to promote.',
    });
  }
  const nightly = found.value;
  const sha = yield* git('rev-list', '-n', '1', nightly);
  const version = chosen || (yield* stableFromNightly(nightly));
  if (!stableVersion.test(version)) {
    return yield* new StableReleaseError({ message: `Stable versions are X.Y.Z, not ${version}.` });
  }
  const latest = latestStable((yield* git('tag', '--list', 'v*')).split('\n'));
  if (latest && !(yield* newerStable(version, latest.slice(1)))) {
    return yield* new StableReleaseError({ message: `v${version} must be newer than ${latest}.` });
  }
  const releases = yield* GitHub.GitHubReleases;
  yield* releases.pages.pipe(
    Stream.runForEach((page) => {
      const existing = page.find((release) => release.tag_name === `v${version}`);
      return existing
        ? Effect.fail(
            new StableReleaseError({
              message: existing.draft
                ? `Delete the existing v${version} draft before promoting again.`
                : `v${version} is already released.`,
            }),
          )
        : Effect.void;
    }),
  );
  return { sha, version, nightly };
});

/** An optional input of the workflow: unset, empty and blank all mean it was not given. */
const input = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.getOrUndefined(Option.map(value, (text) => text.trim()))),
  );

const resolve = Command.make(
  'resolve-stable-release',
  {},
  Effect.fn(function* () {
    const ref = yield* Config.option(Config.String('GITHUB_REF'));
    if (Option.getOrUndefined(ref) !== 'refs/heads/main') {
      return yield* new StableReleaseError({ message: 'Run the stable release from main.' });
    }
    const path = yield* Path.Path;
    const root = path.resolve();
    const main = (yield* output('git', ['rev-parse', 'HEAD'])).trim();
    const { sha, version, nightly } = yield* resolveStableRelease(
      main,
      { nightly: yield* input('NIGHTLY_TAG'), version: yield* input('RELEASE_VERSION') },
      root,
    );
    yield* Console.log(`Promoting ${nightly} (${sha}) as v${version}.`);
    yield* writeOutputs({ sha, version, nightly });
  }),
).pipe(Command.withDescription('Pick the published Nightly a Stable release promotes'));

if (import.meta.main) {
  resolve.pipe(
    Command.run({ version: '1.0.0' }),
    Effect.provide(GitHub.layer.pipe(Layer.provide(GitHub.httpClientLayer))),
    runScript,
  );
}
