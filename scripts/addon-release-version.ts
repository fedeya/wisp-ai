// @effect-migrated
// The addon's release version, MAJOR.MINOR.PATCH: the base version in its TOC,
// with a patch that counts the first-parent commits changing the addon since then.
//   node scripts/addon-release-version.ts version [ref]   prints it for ref (HEAD)
//   node scripts/addon-release-version.ts stamp <toc> <version>
import { Console, Effect, FileSystem, Option, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { addonVersionFromToc } from '../apps/server/src/game/addon-version.ts';
import { output } from './child-process.ts';
import { runScript } from './run-script.ts';

export class AddonVersionError extends Schema.TaggedError<AddonVersionError>()(
  'AddonVersionError',
  { message: Schema.String },
) {}

const versioningStart = 'scripts/addon-release-version.ts';
const addonToc = 'addon/WispAI/WispAI.toc';
const addonInputs = ['addon/WispAI', 'packages/protocol/src/addon-helpers.ts'];

/** The addon's release version at `ref` of the full Git checkout in `root`. */
export const addonReleaseVersion = Effect.fnUntraced(function* (
  root: string,
  ref: string = 'HEAD',
) {
  const git = (...args: string[]) =>
    output('git', args, { cwd: root }).pipe(Effect.map((text) => text.trim()));
  if ((yield* git('rev-parse', '--is-shallow-repository')) === 'true') {
    return yield* new AddonVersionError({
      message: 'Addon release version requires a full Git checkout. Fetch the complete history.',
    });
  }
  const start = yield* git(
    'log',
    '--first-parent',
    '--diff-filter=A',
    '-1',
    '--format=%H',
    ref,
    '--',
    versioningStart,
  );
  if (!start) {
    return yield* new AddonVersionError({
      message: 'Addon release version requires a commit that includes the versioning script.',
    });
  }
  const baseAt = (commit: string) =>
    Effect.map(git('show', `${commit}:${addonToc}`), addonVersionFromToc);
  const base = yield* baseAt(ref);
  const versionLine = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.exec(base ?? '');
  if (!versionLine) {
    return yield* new AddonVersionError({
      message: `Set the addon base version in ${addonToc} to MAJOR.MINOR.0.`,
    });
  }

  const tocChanges = (yield* git(
    'log',
    '--first-parent',
    '--diff-filter=AM',
    '--format=%H',
    `${start}..${ref}`,
    '--',
    addonToc,
  ))
    .split(/\r?\n/)
    .filter(Boolean);
  // Find the start of the current base without resetting on unrelated TOC edits.
  let baseCommit = start;
  for (const commit of [...tocChanges, start]) {
    if ((yield* baseAt(commit)) !== base) break;
    baseCommit = commit;
  }

  const patch = yield* git(
    'rev-list',
    '--first-parent',
    '--count',
    `${baseCommit}..${ref}`,
    '--',
    ...addonInputs,
  );
  return `${versionLine[1]}.${versionLine[2]}.${patch}`;
});

/** Sets the Version header of the TOC file `toc` to `version`. */
export const stampAddonReleaseVersion = Effect.fnUntraced(function* (toc: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(toc);
  const header = /^(##[\t ]*Version:[\t ]*)[^\r\n]*/m;
  if (!header.test(source)) {
    return yield* new AddonVersionError({
      message: 'Missing Version header in bundled WispAI.toc.',
    });
  }
  yield* fs.writeFileString(
    toc,
    source.replace(header, (_match, prefix: string) => prefix + version),
  );
});

const printVersion = Command.make(
  'version',
  {
    ref: Argument.String('ref').pipe(
      Argument.withDescription('The commit to version; HEAD when absent'),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ ref }) {
    const path = yield* Path.Path;
    yield* Console.log(yield* addonReleaseVersion(path.resolve(), Option.getOrUndefined(ref)));
  }),
).pipe(Command.withDescription("Print the addon's release version"));

const stamp = Command.make(
  'stamp',
  {
    toc: Argument.String('toc').pipe(Argument.withDescription('The TOC file to stamp')),
    version: Argument.String('version').pipe(Argument.withDescription('The version to stamp')),
  },
  Effect.fn(function* ({ toc, version }) {
    const path = yield* Path.Path;
    yield* stampAddonReleaseVersion(path.resolve(toc), version);
  }),
).pipe(Command.withDescription("Set a TOC file's Version header"));

if (import.meta.main) {
  Command.make('addon-release-version').pipe(
    Command.withSubcommands([printVersion, stamp]),
    Command.withDescription("The addon's release version"),
    Command.run({ version: '1.0.0' }),
    runScript,
  );
}
