// @effect-migrated
// Publishes the updater manifest last, after the draft contains every referenced
// artifact; for a Nightly, publishes the release and moves the Nightly feed to it.
//   RELEASE_TAG=<tag> RELEASE_NIGHTLY=true|false node scripts/finalize-release.ts
import { newerNightly } from '@wisp/releases';
import { Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema } from 'effect';
import { Command } from 'effect/cli';
import { inherit, output } from './child-process.ts';
import { runScript } from './run-script.ts';

export class FinalizeReleaseError extends Schema.TaggedError<FinalizeReleaseError>()(
  'FinalizeReleaseError',
  { message: Schema.String },
) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const DraftRelease = Schema.fromJsonString(
  Schema.Struct({ body: Schema.String, isDraft: Schema.Boolean }),
);
/** An updater manifest (latest.json), with every field it has in its order. */
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const ManifestVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const ReleaseAssets = Schema.fromJsonString(
  Schema.Struct({ assets: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);

const gh = (args: readonly string[]) => output('gh', args);
const ghShown = (args: readonly string[]) => inherit('gh', args);

/** Whether `candidate` is a later Nightly than `previous`; fails unless both are Nightly versions. */
const isNewerNightly = (candidate: string, previous: string) =>
  Effect.try({
    try: () => newerNightly(candidate, previous),
    catch: (cause) =>
      new FinalizeReleaseError({
        message: Predicate.isError(cause) ? cause.message : String(cause),
      }),
  });

/** Points the moving Nightly feed at this build unless it already has a newer one. */
const moveNightlyFeed = Effect.fnUntraced(function* (version: string) {
  // The moving feed is updated last. Installer URLs remain immutable versioned URLs.
  const existing = yield* gh(['release', 'view', 'nightly', '--json', 'assets']).pipe(
    Effect.flatMap(Schema.decodeEffect(ReleaseAssets)),
    Effect.option,
  );
  if (Option.isNone(existing)) {
    const sha = yield* Config.String('GITHUB_SHA');
    yield* ghShown([
      'release',
      'create',
      'nightly',
      '--target',
      sha,
      '--prerelease',
      '--latest=false',
      '--title',
      'Nightly update feed',
      '--notes',
      'Experimental builds from main.',
    ]);
  }
  if (
    Option.isSome(existing) &&
    existing.value.assets.some((asset) => asset.name === 'latest.json')
  ) {
    const previous = yield* Schema.decodeEffect(ManifestVersion)(
      yield* gh(['release', 'download', 'nightly', '--pattern', 'latest.json', '--output', '-']),
    );
    if (!(yield* isNewerNightly(version, previous.version))) {
      yield* Console.log('A newer nightly is already available; leaving its feed unchanged.');
      return;
    }
  }
  yield* ghShown(['release', 'upload', 'nightly', 'dist/latest.json', '--clobber']);
});

const finalize = Command.make(
  'finalize-release',
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const releaseTag = yield* Config.option(Config.String('RELEASE_TAG'));
    const refName = yield* Config.option(Config.String('GITHUB_REF_NAME'));
    const tag = Option.getOrUndefined(Option.orElse(releaseTag, () => refName));
    const { version } = yield* Schema.decodeEffect(PackageJson)(
      yield* fs.readFileString(path.resolve('package.json')),
    );
    if (tag !== `v${version}`) {
      return yield* new FinalizeReleaseError({
        message: 'Release tag does not match the app version.',
      });
    }
    const release = yield* Schema.decodeEffect(DraftRelease)(
      yield* gh(['release', 'view', tag, '--json', 'body,isDraft']),
    );
    if (!release.isDraft) {
      return yield* new FinalizeReleaseError({ message: 'Only draft releases can be prepared.' });
    }
    const manifestFile = path.resolve('dist/latest.json');
    const manifest = yield* Schema.decodeEffect(Manifest)(yield* fs.readFileString(manifestFile));
    if (manifest.version !== version) {
      return yield* new FinalizeReleaseError({
        message: 'Update manifest version does not match.',
      });
    }
    yield* fs.writeFileString(
      manifestFile,
      JSON.stringify({ ...manifest, notes: release.body || manifest.notes }, null, 2) + '\n',
    );
    yield* ghShown(['release', 'upload', tag, 'dist/latest.json', '--clobber']);
    const nightly = yield* Config.option(Config.String('RELEASE_NIGHTLY'));
    if (Option.getOrUndefined(nightly) === 'true') {
      yield* ghShown(['release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false']);
      yield* moveNightlyFeed(version);
    }
  }),
).pipe(Command.withDescription('Attach the updater manifest with its release notes'));

finalize.pipe(Command.run({ version: '1.0.0' }), runScript);
