// @effect-migrated
// Runs the command-line tools the release scripts drive (git, gh, changie).
import { Effect, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

/** A command could not start, or it exited with a code other than 0. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()('CommandFailed', {
  message: Schema.String,
  /** Absent when the command could not start. */
  exitCode: Schema.optionalKey(Schema.Int),
}) {}

export interface CommandOptions {
  /** The working directory; this process's own when absent. */
  readonly cwd?: string | undefined;
  /** Variables to set on top of this process's environment. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** How a command that ran to its end finished. */
export interface Completed {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commandLine = (command: string, args: readonly string[]) => [command, ...args].join(' ');

const notStarted = (command: string, args: readonly string[]) => (cause: { message: string }) =>
  new CommandFailed({ message: `Cannot run ${commandLine(command, args)}: ${cause.message}` });

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * Runs a command to its end and collects its output. Fails only when the
 * command cannot run; the caller decides what its exit code means.
 */
export const execute = Effect.fnUntraced(function* (
  command: string,
  args: readonly string[],
  { cwd, env }: CommandOptions = {},
): Effect.fn.Return<Completed, CommandFailed, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: true,
        detached: false,
        stdin: 'ignore',
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [text(handle.stdout), text(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    return { exitCode, stdout, stderr };
  }).pipe(Effect.scoped, Effect.mapError(notStarted(command, args)));
});

const failedWith = (command: string, args: readonly string[], { exitCode, stderr }: Completed) =>
  new CommandFailed({
    message: [`Command failed: ${commandLine(command, args)}`, stderr.trim()]
      .filter(Boolean)
      .join('\n'),
    exitCode,
  });

/** The standard output of a command that must exit with 0. */
export const output = Effect.fnUntraced(function* (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) {
  const completed = yield* execute(command, args, options);
  if (completed.exitCode !== 0) {
    return yield* failedWith(command, args, completed);
  }
  return completed.stdout;
});

/** Runs a command that must exit with 0, showing its output in this process's own. */
export const inherit = Effect.fnUntraced(function* (
  command: string,
  args: readonly string[],
  { cwd, env }: CommandOptions = {},
): Effect.fn.Return<void, CommandFailed, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: true,
        detached: false,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    )
    .pipe(Effect.mapError(notStarted(command, args)));
  if (exitCode !== 0) {
    return yield* failedWith(command, args, { exitCode, stdout: '', stderr: '' });
  }
});
