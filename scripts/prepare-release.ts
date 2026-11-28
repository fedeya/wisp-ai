// @effect-migrated
// Stamps the release version into this checkout and writes dist/release-notes.md.
//   node scripts/prepare-release.ts
// RELEASE_CHANNEL and RELEASE_VERSION come from the release workflow's resolve job.
// The version is stamped into this checkout only; main is updated after publication.
import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { writeOutputs } from './github-actions.ts';
import * as GitHub from './github-releases.ts';
import {
  latestStableTag,
  nightlyNotes,
  previousPublishedNightly,
  stableNotes,
} from './release-notes.ts';
import { newerStable, nightlyBuildVersion, syncVersion } from './release-version.ts';
import { runScript } from './run-script.ts';

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/** A Nightly's version follows the newer of main's version and the last Stable tag. */
const prepareNightly = Effect.fnUntraced(function* (root: string) {
  const sha = yield* Config.String('GITHUB_SHA');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { version: committed } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString(path.resolve(root, 'package.json')),
  );
  // After a stable promotion and before main records it, the tag is ahead.
  const stable = Option.map(yield* latestStableTag(sha, root), (tag) => tag.slice(1));
  const base =
    Option.isSome(stable) && (yield* newerStable(stable.value, committed))
      ? stable.value
      : committed;
  const version = yield* nightlyBuildVersion(
    base,
    yield* Config.String('GITHUB_RUN_NUMBER').pipe(Config.withDefault('')),
    yield* Config.String('GITHUB_RUN_ATTEMPT').pipe(Config.withDefault('')),
  );
  yield* syncVersion(version, root);
  const previous = yield* previousPublishedNightly(version, sha, root);
  return { version, notes: yield* nightlyNotes(sha, root, previous) };
});

const prepareStable = Effect.fnUntraced(function* (root: string) {
  const version = yield* Config.String('RELEASE_VERSION').pipe(Config.withDefault(''));
  const notes = yield* stableNotes(version, root);
  yield* syncVersion(version, root);
  return { version, notes };
});

const prepare = Command.make(
  'prepare-release',
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve();
    const channel = yield* Config.option(Config.String('RELEASE_CHANNEL'));
    const nightly = Option.getOrUndefined(channel) !== 'stable';
    const { version, notes } = nightly ? yield* prepareNightly(root) : yield* prepareStable(root);
    yield* fs.makeDirectory(path.resolve(root, 'dist'), { recursive: true });
    yield* fs.writeFileString(path.resolve(root, 'dist/release-notes.md'), notes);
    yield* writeOutputs({ version, tag: `v${version}`, nightly });
  }),
).pipe(Command.withDescription('Stamp the release version and write the shared release notes'));

prepare.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(GitHub.layer.pipe(Layer.provide(GitHub.httpClientLayer))),
  runScript,
);
