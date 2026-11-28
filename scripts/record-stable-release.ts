// @effect-migrated
// Runs on main after a Stable release is published: archives its published notes,
// removes the Changie fragments that release shipped (fragments merged after the
// promoted Nightly stay for the next one) and moves main's version forward.
//   RELEASE_TAG=vX.Y.Z RELEASE_BODY=<notes> node scripts/record-stable-release.ts
import { stableVersion } from '@wisp/releases';
import { Config, Console, Effect, FileSystem, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { output } from './child-process.ts';
import { validateNotes } from './release-notes.ts';
import { runScript } from './run-script.ts';
import { newerStable, ReleaseVersionError, syncVersion } from './release-version.ts';

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/** Records the published `tag` with its notes `body`; returns the fragments it removed. */
export const recordStableRelease = Effect.fnUntraced(function* (
  tag: string,
  body: string,
  root: string,
) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !stableVersion.test(version)) {
    return yield* new ReleaseVersionError({ message: `Not a stable tag: ${tag}` });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.resolve(root, `releases/${version}.md`),
    yield* validateNotes(body.replaceAll(/\r\n/g, '\n')),
  );
  const shipped = (yield* output(
    'git',
    ['ls-tree', '--name-only', `${tag}^{commit}`, 'releases/unreleased/'],
    {
      cwd: root,
    },
  ))
    .split('\n')
    .filter((file) => file.endsWith('.yaml'));
  for (const file of shipped) {
    yield* fs.remove(path.resolve(root, file), { force: true });
  }
  const { version: committed } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString(path.resolve(root, 'package.json')),
  );
  if (yield* newerStable(version, committed)) {
    yield* syncVersion(version, root);
  }
  return shipped;
});

const record = Command.make(
  'record-stable-release',
  {},
  Effect.fn(function* () {
    const path = yield* Path.Path;
    const tag = yield* Config.String('RELEASE_TAG');
    const body = yield* Config.String('RELEASE_BODY');
    const shipped = yield* recordStableRelease(tag, body, path.resolve());
    yield* Console.log(`Archived ${tag} and ${shipped.length} shipped notes.`);
  }),
).pipe(Command.withDescription("Archive a published Stable release's notes on main"));

if (import.meta.main) {
  record.pipe(Command.run({ version: '1.0.0' }), runScript);
}
