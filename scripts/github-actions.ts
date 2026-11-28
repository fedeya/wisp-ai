// @effect-migrated
// What the release scripts share with the GitHub Actions runner.
import { Config, Effect, FileSystem, Option } from 'effect';

/**
 * Appends `name=value` lines to the step's outputs file, in the given order.
 * Outside Actions, where `GITHUB_OUTPUT` is unset, it writes nothing.
 */
export const writeOutputs = Effect.fnUntraced(function* (
  outputs: Readonly<Record<string, string | boolean>>,
) {
  const file = yield* Config.option(Config.String('GITHUB_OUTPUT'));
  if (Option.isNone(file)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`);
  yield* fs.writeFileString(file.value, lines.join(''), { flag: 'a' });
});
