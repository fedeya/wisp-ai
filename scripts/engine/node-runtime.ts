// @effect-migrated
// The Node installation and module resolution the build scripts package from.
import { createRequire } from 'node:module';
import { Effect, FileSystem, Path, Predicate, Schema } from 'effect';

export class NpmNotFound extends Schema.TaggedError<NpmNotFound>()('NpmNotFound', {
  message: Schema.String,
}) {}

export class ModuleNotFound extends Schema.TaggedError<ModuleNotFound>()('ModuleNotFound', {
  message: Schema.String,
}) {}

/** The npm that ships with the Node running this script. */
export const findNpmDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const relative of [
    'npm',
    'node_modules/npm',
    '../node_modules/npm',
    '../lib/node_modules/npm',
  ]) {
    const candidate = path.resolve(path.dirname(process.execPath), relative);
    // Only a missing file moves on to the next candidate; other failures stop.
    if (yield* fs.exists(path.join(candidate, 'bin/npx-cli.js'))) {
      return candidate;
    }
  }
  return yield* new NpmNotFound({ message: 'Cannot locate npm in the build Node distribution.' });
});

/**
 * The file `specifier` names for `require` in the module at `from` (a path or
 * file URL), so a script can find a package that another workspace depends on.
 */
export const resolveModule = (from: string, specifier: string) =>
  Effect.try({
    try: () => createRequire(from).resolve(specifier),
    catch: (cause) =>
      new ModuleNotFound({
        message: Predicate.isError(cause) ? cause.message : `Cannot find module ${specifier}`,
      }),
  });
