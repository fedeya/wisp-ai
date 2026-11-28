// @effect-migrated
// Prints the fingerprint of the native executable's inputs in the working
// directory, and writes it as the step's `key` output for the release cache.
//   node scripts/native-cache-key.ts
import { Console, Effect, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { environmentVariable } from './environment.ts';
import { writeOutputs } from './github-actions.ts';
import { nativeBuildContext, nativeBuildKey } from './native-cache.ts';
import { runScript } from './run-script.ts';

export class CustomTauriConfig extends Schema.TaggedError<CustomTauriConfig>()(
  'CustomTauriConfig',
  { message: Schema.String },
) {}

const fingerprint = Command.make(
  'native-cache-key',
  {},
  Effect.fn(function* () {
    if (yield* environmentVariable('TAURI_CONFIG')) {
      return yield* new CustomTauriConfig({
        message: 'Release caching requires the checked-in Tauri configuration.',
      });
    }
    const path = yield* Path.Path;
    const root = path.resolve();
    const key = yield* nativeBuildKey(root, yield* nativeBuildContext(root));
    yield* writeOutputs({ key });
    yield* Console.log(key);
  }),
).pipe(Command.withDescription("Fingerprint the native executable's inputs"));

if (import.meta.main) {
  fingerprint.pipe(Command.run({ version: '1.0.0' }), runScript);
}
