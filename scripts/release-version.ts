// @effect-migrated
// Release versions: stamping one into every app manifest, and the version math.
//   node scripts/release-version.ts <version>
import { releaseChannel, stableVersion } from '@wisp/releases';
import { Effect, FileSystem, Path, Predicate, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { runScript } from './run-script.ts';

export class ReleaseVersionError extends Schema.TaggedError<ReleaseVersionError>()(
  'ReleaseVersionError',
  { message: Schema.String },
) {}

/** A Stable version, X.Y.Z. */
export const StableVersion = Schema.String.pipe(
  Schema.check(Schema.isPattern(stableVersion)),
  Schema.brand('StableVersion'),
);
export type StableVersion = typeof StableVersion.Type;
export const isStableVersion = Schema.is(StableVersion);

/** The release channel of a version; fails on one that is neither Stable nor Nightly. */
export const releaseChannelOf = (version: string) =>
  Effect.try({
    try: () => releaseChannel(version),
    catch: (cause) =>
      new ReleaseVersionError({
        message: Predicate.isError(cause) ? cause.message : String(cause),
      }),
  });

/** Stamps `version` into every package manifest, the Tauri config and the Cargo files. */
export const syncVersion = Effect.fnUntraced(function* (version: string, root: string) {
  yield* releaseChannelOf(version);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const entry of yield* fs.readDirectoryEntries(path.resolve(root, group))) {
      if (entry.type === 'Directory') {
        paths.push(`${group}/${entry.name}/package.json`);
      }
    }
  }
  paths.push(
    'scripts/package.json',
    'tests/package.json',
    'addon/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  );
  const replace = Effect.fnUntraced(function* (file: string, pattern: RegExp) {
    const content = yield* fs.readFileString(path.resolve(root, file));
    yield* fs.writeFileString(path.resolve(root, file), content.replace(pattern, `$1${version}"`));
  });
  for (const file of paths) {
    yield* replace(file, /("version"\s*:\s*")[^"]+"/);
  }
  yield* replace('apps/desktop/src-tauri/Cargo.toml', /^(version = ")[^"]+"/m);
  yield* replace(
    'apps/desktop/src-tauri/Cargo.lock',
    /(\[\[package\]\]\r?\nname = "wisp"\r?\nversion = ")[^"]+"/,
  );
});

/** Whether `candidate` is a later Stable version than `previous`. */
export function isNewerStable(candidate: StableVersion, previous: StableVersion): boolean {
  const next = candidate.split('.').map(Number),
    last = previous.split('.').map(Number);
  for (const [index, part] of next.entries()) {
    const previousPart = last[index];
    if (previousPart === undefined) {
      return false;
    }
    if (part !== previousPart) {
      return part > previousPart;
    }
  }
  return false;
}

/** Whether `candidate` is a later Stable version than `previous`; fails unless both are X.Y.Z. */
export const newerStable = Effect.fnUntraced(function* (candidate: string, previous: string) {
  if (!isStableVersion(candidate) || !isStableVersion(previous)) {
    return yield* new ReleaseVersionError({ message: 'Expected stable versions.' });
  }
  return isNewerStable(candidate, previous);
});

/** The Nightly version a release run builds after the Stable version `stable`. */
export const nightlyBuildVersion = Effect.fnUntraced(function* (
  stable: string,
  run: string,
  attempt: string,
) {
  const [major, minor, patch] = stable.split('.').map(Number);
  if (
    !/^\d+\.\d+\.\d+$/.test(stable) ||
    patch === undefined ||
    !/^\d+$/.test(run) ||
    !/^\d+$/.test(attempt)
  ) {
    return yield* new ReleaseVersionError({ message: 'Invalid nightly build identity.' });
  }
  return `${major}.${minor}.${patch + 1}-nightly.${run}.${attempt}`;
});

const command = Command.make(
  'release-version',
  {
    version: Argument.String('version').pipe(
      Argument.withDescription('The Stable or Nightly version to stamp'),
    ),
  },
  Effect.fn(function* ({ version }) {
    const path = yield* Path.Path;
    yield* syncVersion(version, path.resolve());
  }),
).pipe(Command.withDescription('Stamp a release version into every app manifest'));

if (import.meta.main) {
  command.pipe(Command.run({ version: '1.0.0' }), runScript);
}
