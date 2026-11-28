// @effect-migrated
// Says whether a push to main changed anything the app release packages.
//   RELEASE_BASE_SHA=<sha> node scripts/release-inputs.ts
import { Config, Console, Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import { output } from './child-process.ts';
import { writeOutputs } from './github-actions.ts';
import { runScript } from './run-script.ts';

const nonAppInputs = [
  /^(?:apps\/web|docs|releases|\.agents|\.github)\//,
  /(?:^|\/)AGENTS\.md$/,
  /^\.changie\.yaml$/,
  /(?:^|\/)README\.[^/]*$/,
  /^scripts\/(?:revalidate-web\.ts|tests\/revalidate-web\.test\.ts)$/,
];

export function needsAppRelease(files: readonly string[]): boolean {
  return files.some((file) => !nonAppInputs.some((pattern) => pattern.test(file)));
}

const variable = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined));

/** The files the pushed branch range changed, or none when the run has no such range. */
const changedFiles = Effect.gen(function* () {
  const before = yield* variable('RELEASE_BASE_SHA');
  // Tags, manual builds and the first push have no previous branch range to filter.
  const branchPush =
    (yield* variable('GITHUB_EVENT_NAME')) === 'push' &&
    (yield* variable('GITHUB_REF_TYPE')) === 'branch';
  if (!branchPush || !before || /^0+$/.test(before)) {
    return Option.none<string[]>();
  }
  const sha = yield* Config.String('GITHUB_SHA');
  const files = yield* output('git', ['diff', '--name-only', '--no-renames', '-z', before, sha]);
  return Option.some(files.split('\0').filter(Boolean));
});

const inputs = Command.make(
  'release-inputs',
  {},
  Effect.fn(function* () {
    const files = yield* changedFiles;
    const app = Option.isNone(files) || needsAppRelease(files.value);
    yield* Console.log('Build app release: ' + app);
    yield* writeOutputs({ app });
  }),
).pipe(Command.withDescription('Say whether the pushed changes need an app release'));

if (import.meta.main) {
  inputs.pipe(Command.run({ version: '1.0.0' }), runScript);
}
