// @effect-migrated
// Replaces the notes of a published release in its body and in the updater
// manifests that carry them, restoring the previous notes when a write fails.
//   pnpm release:notes vX.Y.Z path/to/notes.md [--apply]
import { Console, Context, Effect, Exit, FileSystem, Layer, Path, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';
import { output } from './child-process.ts';
import { validateNotes } from './release-notes.ts';
import { releaseChannelOf } from './release-version.ts';
import { runScript } from './run-script.ts';

/** An updater manifest (latest.json), with every field it has in its order. */
export const Manifest = Schema.Record(Schema.String, Schema.Json);
export type Manifest = typeof Manifest.Type;

export const Release = Schema.Struct({
  body: Schema.String,
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
});
export type Release = typeof Release.Type;

export class ReleaseStoreError extends Schema.TaggedError<ReleaseStoreError>()(
  'ReleaseStoreError',
  { message: Schema.String },
) {}

/** Where a release's body and its updater manifests are read and replaced. */
export class ReleaseStore extends Context.Service<
  ReleaseStore,
  {
    readonly release: (tag: string) => Effect.Effect<Release, ReleaseStoreError>;
    readonly manifest: (tag: string) => Effect.Effect<Manifest, ReleaseStoreError>;
    readonly writeBody: (tag: string, body: string) => Effect.Effect<void, ReleaseStoreError>;
    readonly writeManifest: (
      tag: string,
      manifest: Manifest,
    ) => Effect.Effect<void, ReleaseStoreError>;
  }
>()('@wisp/scripts/ReleaseStore') {}

const failed = (cause: { readonly message: string }) =>
  new ReleaseStoreError({ message: cause.message });

/** The releases of fedeya/wisp-ai, through the GitHub CLI. */
export const githubLayer = Layer.effect(
  ReleaseStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-notes-' });
    const gh = (args: readonly string[]) =>
      output('gh', [...args, '--repo', 'fedeya/wisp-ai']).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(failed),
      );
    const decode = <S extends Schema.Decoder<unknown>>(schema: S) => {
      const decodeJson = Schema.decodeEffect(Schema.fromJsonString(schema));
      return (text: string) => decodeJson(text).pipe(Effect.mapError(failed));
    };
    const decodeRelease = decode(Release);
    const decodeManifest = decode(Manifest);
    const write = (name: string, content: string) => {
      const file = path.join(directory, name);
      return fs.writeFileString(file, content).pipe(Effect.mapError(failed), Effect.as(file));
    };
    return ReleaseStore.of({
      release: (tag) =>
        gh(['release', 'view', tag, '--json', 'body,isDraft,isPrerelease']).pipe(
          Effect.flatMap(decodeRelease),
        ),
      manifest: (tag) =>
        gh(['release', 'download', tag, '--pattern', 'latest.json', '--output', '-']).pipe(
          Effect.flatMap(decodeManifest),
        ),
      writeBody: (tag, body) =>
        write('notes.md', body).pipe(
          Effect.flatMap((file) => gh(['release', 'edit', tag, '--notes-file', file])),
          Effect.asVoid,
        ),
      writeManifest: (tag, manifest) =>
        write('latest.json', JSON.stringify(manifest, null, 2) + '\n').pipe(
          Effect.flatMap((file) => gh(['release', 'upload', tag, file, '--clobber'])),
          Effect.asVoid,
        ),
    });
  }),
);

/** The notes, the release or a manifest do not fit together; nothing was written. */
export class NotesSyncError extends Schema.TaggedError<NotesSyncError>()('NotesSyncError', {
  message: Schema.String,
}) {}

/** A write or its verification failed after writing began; the rollback was attempted. */
export class NotesSyncFailed extends Schema.TaggedError<NotesSyncFailed>()('NotesSyncFailed', {
  message: Schema.String,
  /** The failure, then each failure of the rollback. */
  failures: Schema.Array(Schema.Defect()),
}) {}

export const syncReleaseNotes = Effect.fnUntraced(function* (
  tag: string,
  content: string,
  apply = false,
) {
  const version = tag.replace(/^v/, '');
  const channel = yield* releaseChannelOf(version);
  if (tag !== `v${version}`) {
    return yield* new NotesSyncError({ message: 'Use a versioned release tag, such as v0.0.7.' });
  }
  const notes = yield* validateNotes(content);
  const store = yield* ReleaseStore;
  const release = yield* store.release(tag);
  if (release.isPrerelease !== (channel === 'nightly')) {
    return yield* new NotesSyncError({ message: 'Release channel does not match its version.' });
  }
  const manifest = yield* store.manifest(tag);
  if (manifest.version !== version) {
    return yield* new NotesSyncError({
      message: 'Release manifest version does not match its tag.',
    });
  }
  const manifests = [{ tag, original: manifest }];
  if (channel === 'nightly' && !release.isDraft) {
    // Only change the moving feed when it still points at this build.
    const moving = yield* store.manifest('nightly');
    if (moving.version === version) {
      manifests.push({ tag: 'nightly', original: moving });
    }
  }
  const targets = manifests.map((entry) => entry.tag);
  if (!apply) {
    return { applied: false, targets, notes };
  }

  const rollback: Effect.Effect<void, ReleaseStoreError>[] = [];
  const write = Effect.gen(function* () {
    for (const entry of manifests) {
      rollback.push(store.writeManifest(entry.tag, entry.original));
      yield* store.writeManifest(entry.tag, { ...entry.original, notes });
    }
    rollback.push(store.writeBody(tag, release.body));
    yield* store.writeBody(tag, notes);
    if ((yield* store.release(tag)).body !== notes) {
      return yield* new NotesSyncError({ message: 'Release body verification failed.' });
    }
    for (const entry of manifests) {
      const written = yield* store.manifest(entry.tag);
      if (JSON.stringify(written) !== JSON.stringify({ ...entry.original, notes })) {
        return yield* new NotesSyncError({
          message: `Manifest verification failed for ${entry.tag}.`,
        });
      }
    }
  });
  yield* write.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const failures: unknown[] = [error];
        for (const undo of rollback.reverse()) {
          const undone = yield* Effect.exit(undo);
          if (Exit.isFailure(undone)) {
            failures.push(undone.cause);
          }
        }
        return yield* new NotesSyncFailed({
          message:
            failures.length > 1
              ? 'Notes sync failed; rollback was incomplete. Inspect the release before retrying.'
              : 'Notes sync failed; previous notes were restored.',
          failures,
        });
      }),
    ),
  );
  return { applied: true, targets, notes };
});

const sync = Command.make(
  'release:notes',
  {
    tag: Argument.String('tag').pipe(Argument.withDescription('The release tag, such as v0.0.7')),
    file: Argument.String('file').pipe(
      Argument.withDescription('The Markdown file with the notes'),
    ),
    apply: Flag.Boolean('apply').pipe(
      Flag.withDescription('Write the notes; without it, only preview them'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ tag, file, apply }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(path.resolve(file));
    const result = yield* syncReleaseNotes(tag, content, apply);
    yield* Console.log(
      `${result.applied ? 'Updated' : 'Preview only:'} ${result.targets.join(', ')}\n\n${result.notes}`,
    );
    if (!result.applied) {
      yield* Console.log(
        'Run again with --apply to synchronize the release body and updater notes.',
      );
    }
  }),
).pipe(Command.withDescription("Replace a published release's notes and its updater notes"));

if (import.meta.main) {
  sync.pipe(Command.run({ version: '1.0.0' }), Effect.provide(githubLayer), runScript);
}
